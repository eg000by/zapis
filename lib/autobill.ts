// Автосчета: два отдельных счёта на ученика — «долг» (проведённые неоплаченные
// занятия) и «вперёд» (одно ближайшее занятие). Ручные счета сохраняются и
// УМЕНЬШАЮТ автосчета (то, что уже выставлено вручную, не выставляем второй раз).
// Вызывается при открытии кабинета (/api/my) и после занятия (pulse) —
// идемпотентно: суммы сверяются и обновляются, лишние автосчета удаляются,
// при нуле — счёт снимается.
import { computeStudentBalance, type StudentBalance } from "./balance";
import {
  createPayment,
  deletePayment,
  outstandingPayments,
  updatePayment,
} from "./payments";
import { createYkPayment, yookassaConfigured } from "./yookassa";
import { getStudent } from "./students";
import type { Student } from "./schema";
import { getPayMethod } from "./settings";

export interface OpenInvoice {
  id: string;
  kind: string;
  amountKopecks: number;
}

// Автосчета бывают только двух видов — «долг» и «вперёд» (manual/package сюда не идут).
type AutoKind = "debt" | "advance";
export type AutoAction =
  | { action: "create"; kind: AutoKind; amountKopecks: number }
  | { action: "update"; id: string; kind: AutoKind; amountKopecks: number }
  | { action: "delete"; id: string; kind: string };

// Чистый планировщик: что сделать со счетами, чтобы они сошлись с балансом.
// debtKopecks — долг за проведённые; advanceKopecks — стоимость незакрытых занятий
// окна «вперёд»; openInvoices — ВСЕ неоплаченные счета ученика (включая ручные).
export function planAutoInvoices(input: {
  debtKopecks: number;
  advanceKopecks: number;
  openInvoices: OpenInvoice[];
}): AutoAction[] {
  const actions: AutoAction[] = [];

  // Ручные неоплаченные счета считаем уже выставленными: сначала они покрывают долг,
  // остаток — занятия «вперёд».
  const billedManual = input.openInvoices
    .filter((p) => p.kind !== "debt" && p.kind !== "advance")
    .reduce((s, p) => s + p.amountKopecks, 0);
  const debtTarget = Math.max(0, input.debtKopecks - billedManual);
  const manualLeft = Math.max(0, billedManual - input.debtKopecks);
  const advanceTarget = Math.max(0, input.advanceKopecks - manualLeft);

  for (const kind of ["debt", "advance"] as const) {
    const target = kind === "debt" ? debtTarget : advanceTarget;
    const existing = input.openInvoices.filter((p) => p.kind === kind);
    // Дубли одного вида (гонка двух открытий кабинета) — оставляем первый, лишние удаляем.
    for (const extra of existing.slice(1)) {
      actions.push({ action: "delete", id: extra.id, kind });
    }
    const first = existing[0];
    if (target <= 0) {
      if (first) actions.push({ action: "delete", id: first.id, kind });
    } else if (!first) {
      actions.push({ action: "create", kind, amountKopecks: target });
    } else if (first.amountKopecks !== target) {
      actions.push({ action: "update", id: first.id, kind, amountKopecks: target });
    }
  }
  return actions;
}

// Стоимость счёта «вперёд» — ровно одно БЛИЖАЙШЕЕ занятие, и только если оно ещё не
// закрыто балансом. Перескакивать через оплаченное занятие к следующему нельзя: иначе
// ученик, оплативший занятие вперёд, в ту же секунду получал бы новый счёт и никогда
// не видел состояния «всё оплачено». Счёт на занятие после появится сам, когда
// оплаченное пройдёт и ближайшим станет следующее.
export function nextLessonCostKopecks(balance: StudentBalance): number {
  for (const o of balance.items) {
    if (o.past) continue;
    return o.paid ? 0 : o.hours * balance.rateKopecks;
  }
  return 0;
}

function fmtRub(kopecks: number): string {
  return `${(kopecks / 100).toLocaleString("ru-RU")} ₽`;
}

function noteFor(kind: "debt" | "advance", amountKopecks: number, rateKopecks: number): string {
  const hours = Math.round(amountKopecks / rateKopecks);
  return kind === "debt"
    ? `Автосчёт: долг за проведённые занятия (${hours} ч)`
    : `Автосчёт: следующее занятие (${hours} ч)`;
}

// Сверяет автосчета ученика с балансом и (при настроенной ЮKassa) выдаёт ссылки
// на оплату всем неоплаченным счетам без ссылки — ручным тоже. Возвращает баланс,
// чтобы вызывающий (/api/my) не считал его второй раз. Всё best-effort:
// недоступность БД/ЮKassa не должна ломать кабинет.
export async function ensureAutoInvoices(
  studentId: string,
  studentName: string,
  preloaded?: Student | null
): Promise<StudentBalance | null> {
  // Строку ученика читаем один раз за запрос: её же передаём в расчёт баланса
  // (кабинет уже загрузил ученика и отдаёт сюда — иначе три одинаковых SELECT'а).
  const student = preloaded !== undefined ? preloaded : await getStudent(studentId);

  // Пробное занятие бесплатное — счетов у пробного ученика быть не может. Если
  // они успели выставиться (ставку спрашивают в боте до выбора «пробное»), снимаем
  // их здесь: иначе кабинет предлагает оплатить занятие, за которое платить не надо.
  // Ручные счета не трогаем — их выставил преподаватель осознанно.
  if (student?.trial) {
    for (const p of await outstandingPayments(studentId)) {
      if (p.kind === "debt" || p.kind === "advance") {
        await deletePayment(p.id);
      }
    }
    return null;
  }

  const balance = await computeStudentBalance(studentId, student);
  if (!balance) return null; // нет ставки — автосчета не считаются

  // Ученик в архиве: будущих занятий у него нет (архив снимает их с календаря), и
  // платить «вперёд» не за что. Остаётся только долг за проведённые — он настоящий.
  const archived = student?.active === false;
  const open = await outstandingPayments(studentId);
  // «Вперёд» — всегда одно ближайшее занятие: сумма к оплате маленькая и понятная.
  const actions = planAutoInvoices({
    debtKopecks: balance.debtKopecks,
    advanceKopecks: archived ? 0 : nextLessonCostKopecks(balance),
    openInvoices: open.map((p) => ({ id: p.id, kind: p.kind, amountKopecks: p.amountKopecks })),
  });

  for (const a of actions) {
    if (a.action === "delete") {
      await deletePayment(a.id);
    } else if (a.action === "create") {
      await createPayment({
        studentId,
        amountKopecks: a.amountKopecks,
        kind: a.kind,
        note: noteFor(a.kind, a.amountKopecks, balance.rateKopecks),
      });
    } else {
      // Сумма изменилась — старая ссылка ЮKassa больше не соответствует счёту.
      await updatePayment(a.id, {
        amountKopecks: a.amountKopecks,
        note: noteFor(a.kind, a.amountKopecks, balance.rateKopecks),
        payLink: "",
        providerPaymentId: "",
      });
    }
  }

  // Способ оплаты: «ЮKassa» — счетам генерируются ссылки; «СБП-перевод» — ссылки не
  // создаются (комиссия провайдера не нужна), в кабинете показываются реквизиты,
  // оплату преподаватель отмечает вручную.
  const method = await getPayMethod().catch(() => "yookassa" as const);

  // Ссылки на оплату: каждому неоплаченному счёту без ссылки — платёж ЮKassa.
  if (method === "yookassa" && yookassaConfigured()) {
    const fresh = actions.length ? await outstandingPayments(studentId) : open;
    for (const p of fresh) {
      if (p.payLink) continue;
      try {
        const yk = await createYkPayment({
          ourPaymentId: p.id,
          amountKopecks: p.amountKopecks,
          description: `Оплата занятий: ${studentName} — ${fmtRub(p.amountKopecks)}`,
        });
        if (yk.confirmationUrl) {
          await updatePayment(p.id, { payLink: yk.confirmationUrl, providerPaymentId: yk.id });
        }
      } catch (e) {
        console.error("yookassa link failed for payment", p.id, e);
      }
    }
  }

  // Ученику про счета и оплаты бот НЕ пишет: деньги живут в личном кабинете, а
  // сообщения о выставленном счёте — самый быстрый способ добиться, чтобы человек
  // отключил уведомления и перестал получать заодно и напоминания о занятиях.
  return balance;
}
