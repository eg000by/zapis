// Сервисный слой «Оплаты». Деньги — целыми копейками. Оплата принимается вне сайта
// (в «Мой налог»: СБП + чек автоматически), поэтому статус «оплачено» ставит
// преподаватель вручную (нет вебхука от «Мой налог»). Общий слой для /admin и бота.
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { payments, type Payment } from "./schema";

export type PaymentStatus = "unpaid" | "paid" | "canceled";
// manual — выставлен вручную; debt — автосчёт за долг; advance — автосчёт на месяц
// вперёд (у экзаменационных — на одно следующее занятие); package — месячный пакет
// ОГЭ/ЕГЭ (кредитует фиксированное число часов, а не деньги÷ставку).
export type PaymentKind = "manual" | "debt" | "advance" | "package";

export async function createPayment(input: {
  studentId: string;
  amountKopecks: number;
  note?: string;
  payLink?: string;
  kind?: PaymentKind;
}): Promise<Payment> {
  const [p] = await db()
    .insert(payments)
    .values({
      studentId: input.studentId,
      amountKopecks: input.amountKopecks,
      note: input.note ?? "",
      payLink: input.payLink ?? "",
      kind: input.kind ?? "manual",
    })
    .returning();
  return p;
}

// Точечное обновление счёта (сумма/заметка/ссылка/платёж провайдера) — для автосчетов.
export async function updatePayment(
  id: string,
  patch: Partial<Pick<Payment, "amountKopecks" | "note" | "payLink" | "providerPaymentId">>
): Promise<void> {
  await db().update(payments).set(patch).where(eq(payments.id, id));
}

// Счёт по id платежа ЮKassa — для вебхука.
export async function getPaymentByProviderId(providerPaymentId: string): Promise<Payment | null> {
  if (!providerPaymentId) return null;
  const [row] = await db()
    .select()
    .from(payments)
    .where(eq(payments.providerPaymentId, providerPaymentId))
    .limit(1);
  return row ?? null;
}

export async function getPayment(id: string): Promise<Payment | null> {
  const [row] = await db().select().from(payments).where(eq(payments.id, id)).limit(1);
  return row ?? null;
}

export async function listStudentPayments(studentId: string): Promise<Payment[]> {
  return db()
    .select()
    .from(payments)
    .where(eq(payments.studentId, studentId))
    .orderBy(desc(payments.createdAt));
}

// Неоплаченные счета ученика — для панели «Ваши записи» и напоминаний.
export async function outstandingPayments(studentId: string): Promise<Payment[]> {
  return db()
    .select()
    .from(payments)
    .where(and(eq(payments.studentId, studentId), eq(payments.status, "unpaid")))
    .orderBy(desc(payments.createdAt));
}

// Сумма всех оплаченных счетов ученика (копейки). Основа балансовой покраски:
// оплачено занятий = сумма ÷ ставка.
export async function sumPaidKopecks(studentId: string): Promise<number> {
  const rows = await db()
    .select({ amount: payments.amountKopecks })
    .from(payments)
    .where(and(eq(payments.studentId, studentId), eq(payments.status, "paid")));
  return rows.reduce((sum, r) => sum + r.amount, 0);
}

// Оплаченные ЧАСЫ ученика — единый расчёт для баланса и покраски. Обычные счета
// кредитуют деньги÷ставку; пакетные («месяц» ОГЭ/ЕГЭ) дают ровно packageLessons
// часов независимо от скидки. moneyKopecks — деньги непакетных оплат (для остатка
// на балансе). packageLessons = 0 → пакетов нет (обычный предмет).
export async function paidHoursBreakdown(
  studentId: string,
  rateKopecks: number,
  packageLessons: number
): Promise<{ paidHours: number; moneyKopecks: number; packageHours: number }> {
  const rows = await db()
    .select({ amount: payments.amountKopecks, kind: payments.kind })
    .from(payments)
    .where(and(eq(payments.studentId, studentId), eq(payments.status, "paid")));
  let moneyKopecks = 0;
  let packageHours = 0;
  for (const r of rows) {
    if (r.kind === "package") packageHours += packageLessons;
    else moneyKopecks += r.amount;
  }
  const fromMoney = rateKopecks > 0 ? Math.floor(moneyKopecks / rateKopecks) : 0;
  return { paidHours: fromMoney + packageHours, moneyKopecks, packageHours };
}

// Неоплаченный пакетный счёт ученика (для повторного показа/переиспользования оффера).
export async function outstandingPackage(studentId: string): Promise<Payment | null> {
  const [row] = await db()
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.studentId, studentId),
        eq(payments.status, "unpaid"),
        eq(payments.kind, "package")
      )
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return row ?? null;
}

export async function setPaymentStatus(id: string, status: PaymentStatus): Promise<void> {
  await db()
    .update(payments)
    .set({ status, paidAt: status === "paid" ? new Date() : null })
    .where(eq(payments.id, id));
}

export async function setPayLink(id: string, payLink: string): Promise<void> {
  await db().update(payments).set({ payLink }).where(eq(payments.id, id));
}

export async function deletePayment(id: string): Promise<void> {
  await db().delete(payments).where(eq(payments.id, id));
}
