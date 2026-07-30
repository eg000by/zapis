// Сервисный слой «Оплаты». Деньги — целыми копейками. Оплата принимается вне сайта
// (в «Мой налог»: СБП + чек автоматически), поэтому статус «оплачено» ставит
// преподаватель вручную (нет вебхука от «Мой налог»). Общий слой для /admin и бота.
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { payments, type Payment } from "./schema";

export type PaymentStatus = "unpaid" | "paid" | "canceled";
// manual — выставлен вручную; debt — автосчёт за долг; advance — автосчёт за одно
// ближайшее занятие (и только если оно ещё не закрыто балансом); package:N — оплата
// вперёд одним платежом: пакет ОГЭ/ЕГЭ со скидкой либо занятия месяца по ставке.
// Кредитует ровно N часов, а не деньги÷ставку.
export type PaymentKind = "manual" | "debt" | "advance" | `package:${number}`;

// Число оплаченных занятий пакета хранится В САМОМ счёте (kind = «package:8»), а не
// берётся из конфига при чтении: иначе правка тарифа задним числом переоценила бы
// уже оплаченные пакеты (8 часов вдруг стали бы 10). Старые строки с kind="package"
// (до этого формата) читаются с запасным значением из текущего тарифа.
export function packageKind(lessons: number): PaymentKind {
  return `package:${lessons}`;
}

export function isPackageKind(kind: string): boolean {
  return kind === "package" || kind.startsWith("package:");
}

export function packageLessonsOf(kind: string, fallbackLessons: number): number {
  const n = Number(kind.slice("package:".length));
  return kind.startsWith("package:") && Number.isFinite(n) && n > 0 ? n : fallbackLessons;
}

// Пакетный счёт среди уже загруженных счетов ученика (самый свежий). Отдельного
// запроса в БД не делаем — списки неоплаченных счетов вызывающие уже держат.
export function findPackageInvoice(rows: Payment[]): Payment | null {
  return rows.find((p) => isPackageKind(p.kind)) ?? null;
}

// Неоплаченные счета по смыслу: долг ≠ аванс ≠ предложение пакета. Долг — только
// за УЖЕ проведённые занятия (автосчёт debt) и ручные счета преподавателя (он
// выставил их осознанно). Счёт «вперёд» — предоплата за будущее занятие, а пакет
// вообще предложение, которое ученик волен не принимать: показывать их как
// задолженность нельзя ни в карточке, ни в аналитике.
export interface OutstandingSummary {
  debtKopecks: number;
  advanceKopecks: number;
  packageKopecks: number;
  totalKopecks: number;
}

export function summarizeOutstanding(
  rows: { kind: string; amountKopecks: number }[]
): OutstandingSummary {
  const sum: OutstandingSummary = {
    debtKopecks: 0,
    advanceKopecks: 0,
    packageKopecks: 0,
    totalKopecks: 0,
  };
  for (const r of rows) {
    sum.totalKopecks += r.amountKopecks;
    if (isPackageKind(r.kind)) sum.packageKopecks += r.amountKopecks;
    else if (r.kind === "advance") sum.advanceKopecks += r.amountKopecks;
    else sum.debtKopecks += r.amountKopecks; // debt и ручные счета
  }
  return sum;
}

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
  patch: Partial<Pick<Payment, "amountKopecks" | "note" | "payLink" | "providerPaymentId" | "kind">>
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

// Оплаченные счета ученика, свежие сверху — история оплат в кабинете («я же платил»
// должно проверяться самим учеником, а не перепиской с преподавателем).
export async function paidPayments(studentId: string, limit = 10): Promise<Payment[]> {
  return db()
    .select()
    .from(payments)
    .where(and(eq(payments.studentId, studentId), eq(payments.status, "paid")))
    .orderBy(desc(payments.paidAt))
    .limit(limit);
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
// кредитуют деньги÷ставку; пакетные («месяц» ОГЭ/ЕГЭ) дают ровно своё число часов
// независимо от скидки. moneyKopecks — деньги непакетных оплат, packageKopecks —
// пакетных (вместе дают всю полученную сумму для остатка на балансе).
// fallbackPackageLessons — для старых строк kind="package" без числа занятий.
export async function paidHoursBreakdown(
  studentId: string,
  rateKopecks: number,
  fallbackPackageLessons: number
): Promise<{
  paidHours: number;
  moneyKopecks: number;
  packageHours: number;
  packageKopecks: number;
}> {
  const rows = await db()
    .select({ amount: payments.amountKopecks, kind: payments.kind })
    .from(payments)
    .where(and(eq(payments.studentId, studentId), eq(payments.status, "paid")));
  let moneyKopecks = 0;
  let packageKopecks = 0;
  let packageHours = 0;
  for (const r of rows) {
    // Сколько часов даёт пакет: из самого счёта, иначе (старые строки) из тарифа.
    const lessons = isPackageKind(r.kind) ? packageLessonsOf(r.kind, fallbackPackageLessons) : 0;
    if (lessons > 0) {
      packageHours += lessons;
      packageKopecks += r.amount;
    } else {
      // Не пакет — или пакет, число занятий которого определить нечем (старая строка
      // у неэкзаменационного предмета). Тогда считаем как обычные деньги: полученная
      // сумма не должна исчезать из баланса ни при каких обстоятельствах.
      moneyKopecks += r.amount;
    }
  }
  const fromMoney = rateKopecks > 0 ? Math.floor(moneyKopecks / rateKopecks) : 0;
  return { paidHours: fromMoney + packageHours, moneyKopecks, packageHours, packageKopecks };
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
