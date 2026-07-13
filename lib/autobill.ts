// Автосчета: два отдельных счёта на ученика — «долг» (проведённые неоплаченные
// занятия) и «на месяц вперёд» (будущие занятия ближайших AUTO_ADVANCE_DAYS дней,
// не закрытые балансом). Ручные счета сохраняются и УМЕНЬШАЮТ автосчета (то, что
// уже выставлено вручную, не выставляем второй раз). Вызывается при открытии
// кабинета (/api/my) — идемпотентно: суммы сверяются и обновляются, лишние
// автосчета удаляются, при нуле — счёт снимается.
import { computeStudentBalance, type StudentBalance } from "./balance";
import {
  createPayment,
  deletePayment,
  outstandingPayments,
  updatePayment,
  type PaymentKind,
} from "./payments";
import { createYkPayment, yookassaConfigured } from "./yookassa";
import { getStudent } from "./students";
import { notifyStudent } from "./notify";
import { escapeHtml } from "./telegram";

// Окно автосчёта «вперёд»: занятия ближайших N дней.
export const AUTO_ADVANCE_DAYS = 30;

export interface OpenInvoice {
  id: string;
  kind: string;
  amountKopecks: number;
}

export type AutoAction =
  | { action: "create"; kind: Exclude<PaymentKind, "manual">; amountKopecks: number }
  | { action: "update"; id: string; kind: Exclude<PaymentKind, "manual">; amountKopecks: number }
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

// Стоимость будущих занятий ближайших дней, не закрытых балансом.
export function advanceCostKopecks(balance: StudentBalance, now: Date): number {
  const horizon = now.getTime() + AUTO_ADVANCE_DAYS * 86400000;
  let hours = 0;
  for (const o of balance.items) {
    if (!o.past && !o.paid && o.start.getTime() <= horizon) hours += o.hours;
  }
  return hours * balance.rateKopecks;
}

function fmtRub(kopecks: number): string {
  return `${(kopecks / 100).toLocaleString("ru-RU")} ₽`;
}

function noteFor(kind: "debt" | "advance", amountKopecks: number, rateKopecks: number): string {
  const hours = Math.round(amountKopecks / rateKopecks);
  return kind === "debt"
    ? `Автосчёт: долг за проведённые занятия (${hours} ч)`
    : `Автосчёт: занятия на месяц вперёд (${hours} ч)`;
}

// Сверяет автосчета ученика с балансом и (при настроенной ЮKassa) выдаёт ссылки
// на оплату всем неоплаченным счетам без ссылки — ручным тоже. Возвращает баланс,
// чтобы вызывающий (/api/my) не считал его второй раз. Всё best-effort:
// недоступность БД/ЮKassa не должна ломать кабинет.
export async function ensureAutoInvoices(
  studentId: string,
  studentName: string
): Promise<StudentBalance | null> {
  const balance = await computeStudentBalance(studentId);
  if (!balance) return null; // нет ставки — автосчета не считаются

  const now = new Date();
  const open = await outstandingPayments(studentId);
  const actions = planAutoInvoices({
    debtKopecks: balance.debtKopecks,
    advanceKopecks: advanceCostKopecks(balance, now),
    openInvoices: open.map((p) => ({ id: p.id, kind: p.kind, amountKopecks: p.amountKopecks })),
  });

  // id созданных/обновлённых счетов — по ним после генерации ссылок уйдёт
  // уведомление ученику в Telegram (если он подключил уведомления).
  const changed = new Map<string, "create" | "update">();
  for (const a of actions) {
    if (a.action === "delete") {
      await deletePayment(a.id);
    } else if (a.action === "create") {
      const p = await createPayment({
        studentId,
        amountKopecks: a.amountKopecks,
        kind: a.kind,
        note: noteFor(a.kind, a.amountKopecks, balance.rateKopecks),
      });
      changed.set(p.id, "create");
    } else {
      // Сумма изменилась — старая ссылка ЮKassa больше не соответствует счёту.
      await updatePayment(a.id, {
        amountKopecks: a.amountKopecks,
        note: noteFor(a.kind, a.amountKopecks, balance.rateKopecks),
        payLink: "",
        providerPaymentId: "",
      });
      changed.set(a.id, "update");
    }
  }

  // Ссылки на оплату: каждому неоплаченному счёту без ссылки — платёж ЮKassa.
  const freshLinks = new Map<string, string>();
  if (yookassaConfigured()) {
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
          freshLinks.set(p.id, yk.confirmationUrl);
        }
      } catch (e) {
        console.error("yookassa link failed for payment", p.id, e);
      }
    }
  }

  // Уведомление ученику о новом/пересчитанном счёте (best-effort).
  if (changed.size) {
    try {
      const s = await getStudent(studentId);
      if (s?.tgChatId) {
        const rows = (await outstandingPayments(studentId)).filter((p) => changed.has(p.id));
        for (const p of rows) {
          const header =
            changed.get(p.id) === "create" ? "💳 <b>Выставлен счёт</b>" : "💳 <b>Счёт пересчитан</b>";
          const link = p.payLink || freshLinks.get(p.id) || "";
          await notifyStudent(
            s,
            `${header}\n\n${fmtRub(p.amountKopecks)}${p.note ? ` · ${escapeHtml(p.note)}` : ""}\n${
              link ? `Оплатить по СБП: ${link}` : "Ссылка на оплату — в личном кабинете."
            }`
          );
        }
      }
    } catch (e) {
      console.error("autobill notify failed", e);
    }
  }

  return balance;
}
