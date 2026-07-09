// Сервисный слой «Оплаты». Деньги — целыми копейками. Оплата принимается вне сайта
// (в «Мой налог»: СБП + чек автоматически), поэтому статус «оплачено» ставит
// преподаватель вручную (нет вебхука от «Мой налог»). Общий слой для /admin и бота.
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "./db";
import { lessonPayments, lessons, payments, students, type Payment } from "./schema";

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

// Оплачено ли занятие: есть ли покрывающий его платёж со статусом paid.
export async function isLessonPaid(lessonId: string): Promise<boolean> {
  const rows = await db()
    .select({ id: payments.id })
    .from(lessonPayments)
    .innerJoin(payments, eq(lessonPayments.paymentId, payments.id))
    .where(and(eq(lessonPayments.lessonId, lessonId), eq(payments.status, "paid")))
    .limit(1);
  return rows.length > 0;
}

// Занятия, покрытые платежом (для расчёта «оплачено ли занятие», Фаза 3).
export async function lessonIdsForPayment(paymentId: string): Promise<string[]> {
  const rows = await db()
    .select({ lessonId: lessonPayments.lessonId })
    .from(lessonPayments)
    .where(eq(lessonPayments.paymentId, paymentId));
  return rows.map((r) => r.lessonId);
}

// Автопривязка платежа к занятиям, если явных связей ещё нет (счёт из бота или без
// отметок на /admin). Число занятий = сумма ÷ ставка ученика; покрываем самые ранние
// неоплаченные, непросмотренные (не отменённые) занятия. Возвращает затронутые lessonId.
// Уважает ручные привязки: если они уже есть — ничего не меняет.
export async function autoAllocatePayment(paymentId: string): Promise<string[]> {
  const existing = await lessonIdsForPayment(paymentId);
  if (existing.length) return existing;

  const p = await getPayment(paymentId);
  if (!p) return [];

  const [s] = await db()
    .select({ rate: students.rateKopecks })
    .from(students)
    .where(eq(students.id, p.studentId))
    .limit(1);
  const rate = s?.rate ?? 0;
  if (rate <= 0) return []; // без ставки число занятий не посчитать
  const count = Math.floor(p.amountKopecks / rate);
  if (count <= 0) return [];

  const candidates = await db()
    .select()
    .from(lessons)
    .where(and(eq(lessons.studentId, p.studentId), ne(lessons.status, "cancelled")))
    .orderBy(asc(lessons.occurrenceStart));

  const chosen: string[] = [];
  for (const l of candidates) {
    if (chosen.length >= count) break;
    if (!l.calendarEventId) continue; // нечего перекрашивать в календаре
    if (await isLessonPaid(l.id)) continue; // уже покрыто другим оплаченным счётом
    chosen.push(l.id);
  }
  if (chosen.length) {
    await db()
      .insert(lessonPayments)
      .values(chosen.map((lessonId) => ({ paymentId, lessonId })))
      .onConflictDoNothing();
  }
  return chosen;
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
