// Сервисный слой «Оплаты». Деньги — целыми копейками. Оплата принимается вне сайта
// (в «Мой налог»: СБП + чек автоматически), поэтому статус «оплачено» ставит
// преподаватель вручную (нет вебхука от «Мой налог»). Общий слой для /admin и бота.
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { lessonPayments, payments, type Payment } from "./schema";

export type PaymentStatus = "unpaid" | "paid" | "canceled";

export async function createPayment(input: {
  studentId: string;
  amountKopecks: number;
  note?: string;
  payLink?: string;
  lessonIds?: string[];
}): Promise<Payment> {
  const [p] = await db()
    .insert(payments)
    .values({
      studentId: input.studentId,
      amountKopecks: input.amountKopecks,
      note: input.note ?? "",
      payLink: input.payLink ?? "",
    })
    .returning();

  const ids = Array.from(new Set((input.lessonIds ?? []).filter(Boolean)));
  if (ids.length) {
    await db()
      .insert(lessonPayments)
      .values(ids.map((lessonId) => ({ paymentId: p.id, lessonId })))
      .onConflictDoNothing();
  }
  return p;
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

// Занятия, покрытые платежом (для расчёта «оплачено ли занятие», Фаза 3).
export async function lessonIdsForPayment(paymentId: string): Promise<string[]> {
  const rows = await db()
    .select({ lessonId: lessonPayments.lessonId })
    .from(lessonPayments)
    .where(eq(lessonPayments.paymentId, paymentId));
  return rows.map((r) => r.lessonId);
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
