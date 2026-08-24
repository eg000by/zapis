import { NextResponse } from "next/server";
import { decodeToken, contactKey } from "@/lib/link";
import { listContactEvents, nextOccurrenceForContact } from "@/lib/google";
import { getStudent, getStudentByContactKey } from "@/lib/students";
import { getGroup, listGroupMembers, GROUP_LIMIT } from "@/lib/groups";
import {
  findPackageInvoice,
  isPackageKind,
  outstandingPayments,
  packageLessonsOf,
  paidPayments,
} from "@/lib/payments";
import { ensureAutoInvoices } from "@/lib/autobill";
import { getPayMethod, getSbpDetails } from "@/lib/settings";
import { botUsername } from "@/lib/telegram";
import { detectExamTariff, packageSavings } from "@/lib/config";

// Пустой блок оплат/баланса — когда ученика нет в CRM или БД недоступна.
const NO_BILLING = {
  payments: [],
  balance: null,
  meetLink: "",
  payHint: "",
  packageOffer: null,
  paidHistory: [],
  lessonPriceKopecks: 0,
  tgNotify: null,
  group: null,
  scheduleKey: "",
} as {
  meetLink: string;
  // Способ оплаты «СБП-перевод»: текст реквизитов вместо кнопки оплаты (иначе пусто).
  payHint: string;
  payments: { id: string; amountKopecks: number; note: string; payLink: string; kind: string }[];
  balance: {
    debtKopecks: number;
    debtHours: number;
    aheadHours: number;
    paidUntil: string | null;
    balanceKopecks: number;
    rateKopecks: number;
    // Ближайшее занятие уже закрыто балансом — кабинет показывает это явно, иначе
    // оплата вперёд выглядит как «деньги ушли, а ничего не изменилось».
    nextPaid: boolean;
  } | null;
  // Пакет занятий для экзаменационных учеников (ОГЭ/ЕГЭ) — второй вариант оплаты
  // ТОГО ЖЕ счёта: оплатив пакет, ученик закрывает и текущий поштучный счёт.
  packageOffer: {
    exam: boolean; // пакет ОГЭ/ЕГЭ со скидкой (иначе — занятия месяца по ставке)
    label: string;
    lessons: number;
    amountKopecks: number;
    perLessonKopecks: number;
    savingsKopecks: number;
    savingsPercent: number;
    payLink: string; // ссылка ЮKassa существующего счёта (в СБП-режиме пусто)
  } | null;
  // История оплат — чтобы «я же платил» проверялось учеником, а не перепиской.
  paidHistory: { id: string; amountKopecks: number; note: string; paidAt: string | null }[];
  // Цена одного занятия — показывается в подтверждении записи (0 — пробное/не задана).
  lessonPriceKopecks: number;
  // Подключение уведомлений в Telegram: deep-link на бота и текущее состояние.
  // null — предлагать нечего (ученик в архиве, бот не настроен).
  tgNotify: { url: string; connected: boolean } | null;
  // Группа, если ученик занимается в группе: расписание общее, поэтому кабинет
  // становится «панелью» — без сетки записи, переносов и отмен.
  group: { name: string; subject: string; members: string[]; limit: number } | null;
  // По какому ключу календаря показывать расписание: ученика или его группы.
  scheduleKey: string;
};

export const dynamic = "force-dynamic";

// Список записей владельца ссылки + счета к оплате + баланс (долг / оплачено до /
// остаток). При открытии кабинета же сверяются автосчета (долг и ближайшее занятие).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const decoded = decodeToken(url.searchParams.get("token"));
  if (!decoded.ok) {
    return NextResponse.json({ error: decoded.reason }, { status: 403 });
  }
  try {
    const personalKey = contactKey(decoded.info);

    // Ученика читаем ДО параллельных запросов: от него зависит, по какому ключу
    // показывать расписание. У участника группы занятие одно на всех и лежит под
    // ключом группы — личных занятий у него нет вовсе.
    const student = await (decoded.info.studentId
      ? getStudent(decoded.info.studentId)
      : getStudentByContactKey(personalKey)
    ).catch((e) => {
      console.error("/api/my student lookup failed", e);
      return null;
    });
    const group = student?.groupId
      ? await getGroup(student.groupId).catch((e) => {
          console.error("/api/my group lookup failed", e);
          return null;
        })
      : null;
    const key = group ? group.contactKey : personalKey;

    // Три независимых источника — параллельно (два запроса к календарю + БД);
    // nextLesson и биллинг — best-effort: их сбой не ломает список записей.
    const [events, nextLesson, billing] = await Promise.all([
      listContactEvents(key, new Date().toISOString()),
      // Ближайшее занятие (конкретная дата) — с учётом отмен и переносов.
      nextOccurrenceForContact(key).catch((e) => {
        console.error("/api/my nextLesson lookup failed", e);
        return null;
      }),
      // Автосчета + счета к оплате + баланс.
      (async () => {
        try {
          const studentId = decoded.info.studentId || student?.id;
          if (!studentId) return NO_BILLING;

          // Сверка автосчетов и ссылок оплаты; вернёт баланс (null — ставка не задана).
          const balance = await ensureAutoInvoices(
            studentId,
            student?.name || decoded.info.name,
            student
          ).catch((e) => {
            console.error("/api/my ensureAutoInvoices failed", e);
            return null;
          });

          const rows = await outstandingPayments(studentId);
          // Режим «СБП-перевод»: кнопки оплаты прячем, вместо них текст реквизитов.
          const method = await getPayMethod().catch(() => "yookassa" as const);
          const payHint = method === "sbp" ? await getSbpDetails().catch(() => "") : "";

          // Оплата вперёд одним платежом — второй вариант оплаты ТОГО ЖЕ счёта:
          // у экзаменационных (ОГЭ/ЕГЭ) это пакет со скидкой, у остальных — занятия
          // месяца по ставке. Показываем только когда счёт-предложение уже выставлен
          // (ensureAutoInvoices создаёт его при наличии подтверждённых занятий). Цену и
          // число занятий берём из САМОГО счёта, а не из конфига: по ссылке ЮKassa
          // спишется именно сумма счёта. Выгоду считаем от фактической ставки ученика
          // (она может быть задана индивидуально) — иначе «старая цена» не сходится со
          // счетами рядом; у обычного ученика скидки нет и выгода выйдет нулевой.
          // У участника группы экзаменационного пакета нет: цена занятия там своя,
          // и «скидка от индивидуального тарифа» была бы неправдой (см. autobill).
          const tariff = group ? null : detectExamTariff(student?.subject || "");
          let packageOffer = null as (typeof NO_BILLING)["packageOffer"];
          const pkgInvoice = findPackageInvoice(rows);
          if (pkgInvoice) {
            const lessons = packageLessonsOf(pkgInvoice.kind, tariff?.packageLessons ?? 0);
            const perLessonKopecks = balance?.rateKopecks || tariff?.hourlyKopecks || 0;
            const sav = packageSavings({
              hourlyKopecks: perLessonKopecks,
              lessons,
              packageKopecks: pkgInvoice.amountKopecks,
            });
            // Число занятий определить нечем (старая строка kind="package" у обычного
            // предмета) — предложение не показываем, чтобы не врать в подписи.
            if (lessons > 0) {
              packageOffer = {
                exam: !!tariff,
                label: tariff?.label ?? "",
                lessons,
                amountKopecks: pkgInvoice.amountKopecks,
                perLessonKopecks,
                savingsKopecks: sav.kopecks,
                savingsPercent: sav.percent,
                payLink: method === "sbp" ? "" : pkgInvoice.payLink || "",
              };
            }
          }
          // История оплат (последние) — best-effort, для блока «оплачено ранее».
          const history = await paidPayments(studentId, 10).catch((e) => {
            console.error("/api/my paid history failed", e);
            return [];
          });

          // Кнопка «Уведомления в Telegram» — только действующему ученику (не архив):
          // бот не может написать первым, ученик подключается сам по deep-link
          // t.me/<бот>?start=<id>, и /start привязывает его chat_id. Имя бота узнаём
          // через getMe (кэшируется); не узнали — кнопку не показываем, чтобы не вести
          // в никуда. Показ дополнительно закрыт гейтом hasConfirmed ниже.
          const tgNotify = await (async () => {
            if (!student?.active) return null;
            const bot = await botUsername().catch(() => "");
            if (!bot) return null;
            return {
              url: `https://t.me/${bot}?start=${student.id}`,
              connected: !!student.tgChatId,
            };
          })().catch((e) => {
            console.error("/api/my tgNotify failed", e);
            return null;
          });

          return {
            tgNotify,
            // Ссылка на занятие у группы общая — она и показывается участникам.
            meetLink: group ? group.meetLink : student?.meetLink || "",
            scheduleKey: key,
            group: group
              ? {
                  name: group.name,
                  subject: group.subject,
                  // Только имена: чужие оплаты и контакты участнику не показываем.
                  members: (await listGroupMembers(group.id).catch(() => []))
                    .filter((m) => m.active)
                    .map((m) => m.name),
                  limit: GROUP_LIMIT,
                }
              : null,
            payHint,
            packageOffer,
            paidHistory: history.map((p) => ({
              id: p.id,
              amountKopecks: p.amountKopecks,
              note: p.note,
              paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : null,
            })),
            // Цена занятия для экрана подтверждения записи: индивидуальная ставка,
            // иначе тариф предмета. У пробного занятия цены нет — оно бесплатное.
            lessonPriceKopecks:
              decoded.info.trial || student?.trial
                ? 0
                : group
                  ? group.rateKopecks
                  : student?.rateKopecks || tariff?.hourlyKopecks || 0,
            // Пакетные счета показываем отдельной карточкой, из общего списка исключаем.
            payments: rows
              .filter((p) => !isPackageKind(p.kind))
              .map((p) => ({
                id: p.id,
                amountKopecks: p.amountKopecks,
                note: p.note,
                payLink: method === "sbp" ? "" : p.payLink,
                kind: p.kind,
              })),
            balance: balance
              ? {
                  debtKopecks: balance.debtKopecks,
                  debtHours: balance.debtHours,
                  aheadHours: balance.aheadHours,
                  paidUntil: balance.paidUntil,
                  balanceKopecks: balance.balanceKopecks,
                  rateKopecks: balance.rateKopecks,
                  nextPaid: balance.nextPaid,
                }
              : null,
          };
        } catch (e) {
          console.error("/api/my billing lookup failed", e);
          return NO_BILLING;
        }
      })(),
    ]);

    // Пока у ученика нет ПОДТВЕРЖДЁННЫХ занятий, ничего «занятийного» не отдаём:
    // ни ссылку на Телемост, ни счета, ни баланс, ни пакет. Заявка в статусе
    // «ждёт подтверждения» сюда не считается. Гейт именно на сервере: скрывать это
    // только в вёрстке — значит отдавать постоянную ссылку на занятие и суммы
    // счетов любому, кто открыл кабинет по ссылке и ещё ничего не подтвердил.
    const hasConfirmed = events.some((e) => e.status === "confirmed");
    return NextResponse.json({
      events,
      payments: hasConfirmed ? billing.payments : [],
      balance: hasConfirmed ? billing.balance : null,
      meetLink: hasConfirmed ? billing.meetLink : "",
      payHint: hasConfirmed ? billing.payHint : "",
      packageOffer: hasConfirmed ? billing.packageOffer : null,
      paidHistory: hasConfirmed ? billing.paidHistory : [],
      tgNotify: hasConfirmed ? billing.tgNotify : null,
      nextLesson: hasConfirmed ? nextLesson : null,
      // Группа — не «занятийные» данные: даже до первого подтверждённого занятия
      // ученик должен видеть, что записан в группу, и что сетки записи здесь нет.
      group: billing.group,
      // Цена занятия — не «занятийные» данные, а прайс: её ученик должен видеть
      // ДО записи, на экране подтверждения. Поэтому гейтом не закрывается.
      lessonPriceKopecks: billing.lessonPriceKopecks,
    });
  } catch (e) {
    console.error("/api/my error", e);
    return NextResponse.json({ error: "Не удалось загрузить записи" }, { status: 500 });
  }
}
