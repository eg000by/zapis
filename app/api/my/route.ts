import { NextResponse } from "next/server";
import { decodeToken, contactKey } from "@/lib/link";
import { listContactEvents, nextOccurrenceForContact } from "@/lib/google";
import { getStudent, getStudentByContactKey } from "@/lib/students";
import { outstandingPayments } from "@/lib/payments";
import { ensureAutoInvoices } from "@/lib/autobill";
import { studentTgInfo } from "@/lib/notify";

// Пустой блок оплат/баланса — когда ученика нет в CRM или БД недоступна.
const NO_BILLING = {
  payments: [],
  balance: null,
  meetLink: "",
  tg: { connected: false, link: "" },
} as {
  meetLink: string;
  // Уведомления в Telegram: подключены ли и deep-link для подключения.
  tg: { connected: boolean; link: string };
  payments: { id: string; amountKopecks: number; note: string; payLink: string; kind: string }[];
  balance: {
    debtKopecks: number;
    debtHours: number;
    aheadHours: number;
    paidUntil: string | null;
    balanceKopecks: number;
    rateKopecks: number;
  } | null;
};

export const dynamic = "force-dynamic";

// Список записей владельца ссылки + счета к оплате + баланс (долг / оплачено до /
// остаток). При открытии кабинета же сверяются автосчета (долг и месяц вперёд).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const decoded = decodeToken(url.searchParams.get("token"));
  if (!decoded.ok) {
    return NextResponse.json({ error: decoded.reason }, { status: 403 });
  }
  try {
    const key = contactKey(decoded.info);

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
          // Строка ученика нужна целиком (meetLink, имя) — по id из токена или по ключу.
          const student = decoded.info.studentId
            ? await getStudent(decoded.info.studentId)
            : await getStudentByContactKey(key);
          const studentId = decoded.info.studentId || student?.id;
          if (!studentId) return NO_BILLING;

          // Сверка автосчетов и ссылок оплаты; вернёт баланс (null — ставка не задана).
          const balance = await ensureAutoInvoices(
            studentId,
            student?.name || decoded.info.name
          ).catch((e) => {
            console.error("/api/my ensureAutoInvoices failed", e);
            return null;
          });

          const rows = await outstandingPayments(studentId);
          const tg = await studentTgInfo(student).catch(() => ({ connected: false, link: "" }));
          return {
            meetLink: student?.meetLink || "",
            tg,
            payments: rows.map((p) => ({
              id: p.id,
              amountKopecks: p.amountKopecks,
              note: p.note,
              payLink: p.payLink,
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
                }
              : null,
          };
        } catch (e) {
          console.error("/api/my billing lookup failed", e);
          return NO_BILLING;
        }
      })(),
    ]);

    return NextResponse.json({
      events,
      payments: billing.payments,
      balance: billing.balance,
      meetLink: billing.meetLink,
      tg: billing.tg,
      nextLesson,
    });
  } catch (e) {
    console.error("/api/my error", e);
    return NextResponse.json({ error: "Не удалось загрузить записи" }, { status: 500 });
  }
}
