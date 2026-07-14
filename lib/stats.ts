// Статистика доходов для админки и бота. Считаем в JS из оплаченных счетов
// (payments.paid_at), группировка по месяцам — в МСК. Деньги — копейки.
import { eq } from "drizzle-orm";
import { db } from "./db";
import { payments, students } from "./schema";
import { MSK_OFFSET_MINUTES } from "./config";

export interface IncomeStats {
  totalKopecks: number; // всего получено за всё время
  thisMonthKopecks: number; // за текущий месяц (МСК)
  prevMonthKopecks: number; // за прошлый месяц
  outstandingKopecks: number; // выставлено, но не оплачено
  activeStudents: number;
  paidCount: number; // число оплаченных счетов
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

// Чистый расчёт статистики из строк — вынесен для тестов (без БД).
export function summarizeIncome(input: {
  paid: { amount: number; paidAt: Date | string | null }[];
  unpaid: { amount: number }[];
  studentsActive: boolean[];
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

  return {
    totalKopecks,
    thisMonthKopecks: perMonth.get(curKey) || 0,
    prevMonthKopecks: perMonth.get(curKey - 1) || 0,
    outstandingKopecks: input.unpaid.reduce((s, r) => s + r.amount, 0),
    activeStudents: input.studentsActive.filter(Boolean).length,
    paidCount: input.paid.length,
    byMonth,
  };
}

export async function computeIncomeStats(now = new Date()): Promise<IncomeStats> {
  const paid = await db()
    .select({ amount: payments.amountKopecks, paidAt: payments.paidAt })
    .from(payments)
    .where(eq(payments.status, "paid"));
  const unpaid = await db()
    .select({ amount: payments.amountKopecks })
    .from(payments)
    .where(eq(payments.status, "unpaid"));
  const studentRows = await db().select({ active: students.active }).from(students);

  return summarizeIncome({
    paid,
    unpaid,
    studentsActive: studentRows.map((s) => s.active),
    now,
  });
}
