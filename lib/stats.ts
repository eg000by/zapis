// Статистика доходов для админки и бота. Считаем в JS из оплаченных счетов
// (payments.paid_at), группировка по месяцам — в МСК. Деньги — копейки.
import { eq } from "drizzle-orm";
import { db } from "./db";
import { payments, students } from "./schema";
import { FREE_COLOR_ID, MISSED_COLOR_ID, MSK_OFFSET_MINUTES } from "./config";
import { summarizeOutstanding } from "./payments";
import { listDayOccurrences } from "./google";

export interface IncomeStats {
  totalKopecks: number; // всего получено за всё время
  thisMonthKopecks: number; // за текущий месяц (МСК)
  prevMonthKopecks: number; // за прошлый месяц
  outstandingKopecks: number; // выставлено, но не оплачено (всего)
  // Разбор неоплаченного по смыслу: долг за проведённые занятия vs предоплата.
  debtKopecks: number; // счета за уже проведённые занятия + ручные
  advanceKopecks: number; // автосчета «вперёд» — предоплата, не задолженность
  packageOfferKopecks: number; // предложенные пакеты ОГЭ/ЕГЭ — ученик волен не брать
  activeStudents: number;
  paidCount: number; // число оплаченных счетов
  // Ожидаемый доход за текущий месяц: все занятия месяца (по календарю) × ставка
  // ученика. Пропуски и бесплатные не считаются. null — посчитать не удалось.
  expectedMonthKopecks: number | null;
  // Последние 6 месяцев (старые → новые) для мини-графика.
  byMonth: { label: string; kopecks: number }[];
}

const MONTHS_SHORT = [
  "янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

// Год и месяц (0–11) момента по МСК.
function mskYearMonth(d: Date): { y: number; m: number } {
  const shifted = new Date(d.getTime() + MSK_OFFSET_MINUTES * 60000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() };
}

// Начало месяца по МСК (в UTC-моменте) со сдвигом на offsetMonths.
function mskMonthStart(now: Date, offsetMonths = 0): Date {
  const { y, m } = mskYearMonth(now);
  return new Date(Date.UTC(y, m + offsetMonths, 1) - MSK_OFFSET_MINUTES * 60000);
}

// Ожидаемый доход за месяц: занятия месяца из календаря × ставка ученика.
// Пропуски (серые) и бесплатные (Sage) не тарифицируются — не считаются.
// Чистая часть — для тестов (без календаря и БД).
export function expectedIncome(
  occurrences: { hours: number; colorId: string | null; studentId: string }[],
  rateByStudent: Map<string, number>
): number {
  let total = 0;
  for (const o of occurrences) {
    if (o.colorId === MISSED_COLOR_ID || o.colorId === FREE_COLOR_ID) continue;
    const rate = rateByStudent.get(o.studentId) || 0;
    total += o.hours * rate;
  }
  return total;
}

// Чистый расчёт статистики из строк — вынесен для тестов (без БД).
export function summarizeIncome(input: {
  paid: { amount: number; paidAt: Date | string | null }[];
  unpaid: { amount: number; kind: string }[];
  studentsActive: boolean[];
  expectedMonthKopecks?: number | null;
  now?: Date;
}): IncomeStats {
  const now = input.now ?? new Date();
  const cur = mskYearMonth(now);
  const key = (y: number, m: number) => y * 12 + m;
  const curKey = key(cur.y, cur.m);

  // Копилки по ключу месяца.
  const perMonth = new Map<number, number>();
  let totalKopecks = 0;
  for (const p of input.paid) {
    totalKopecks += p.amount;
    const when = p.paidAt ? new Date(p.paidAt) : null;
    if (!when) continue;
    const { y, m } = mskYearMonth(when);
    perMonth.set(key(y, m), (perMonth.get(key(y, m)) || 0) + p.amount);
  }

  const byMonth: { label: string; kopecks: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const total = curKey - i;
    const m = ((total % 12) + 12) % 12;
    byMonth.push({ label: MONTHS_SHORT[m], kopecks: perMonth.get(total) || 0 });
  }

  const outstanding = summarizeOutstanding(
    input.unpaid.map((r) => ({ kind: r.kind, amountKopecks: r.amount }))
  );

  return {
    totalKopecks,
    thisMonthKopecks: perMonth.get(curKey) || 0,
    prevMonthKopecks: perMonth.get(curKey - 1) || 0,
    outstandingKopecks: outstanding.totalKopecks,
    debtKopecks: outstanding.debtKopecks,
    advanceKopecks: outstanding.advanceKopecks,
    packageOfferKopecks: outstanding.packageKopecks,
    activeStudents: input.studentsActive.filter(Boolean).length,
    paidCount: input.paid.length,
    expectedMonthKopecks: input.expectedMonthKopecks ?? null,
    byMonth,
  };
}

export async function computeIncomeStats(now = new Date()): Promise<IncomeStats> {
  const paid = await db()
    .select({ amount: payments.amountKopecks, paidAt: payments.paidAt })
    .from(payments)
    .where(eq(payments.status, "paid"));
  const unpaid = await db()
    .select({ amount: payments.amountKopecks, kind: payments.kind })
    .from(payments)
    .where(eq(payments.status, "unpaid"));
  const studentRows = await db()
    .select({ id: students.id, active: students.active, rate: students.rateKopecks })
    .from(students);

  // Ожидаемый доход за месяц (best-effort: календарь может быть недоступен).
  let expected: number | null = null;
  try {
    const occ = await listDayOccurrences(mskMonthStart(now, 0), mskMonthStart(now, 1));
    const rates = new Map(studentRows.map((s) => [s.id, s.rate]));
    expected = expectedIncome(occ, rates);
  } catch (e) {
    console.error("expected income failed", e);
  }

  return summarizeIncome({
    paid,
    unpaid,
    studentsActive: studentRows.map((s) => s.active),
    expectedMonthKopecks: expected,
    now,
  });
}
