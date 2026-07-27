// Статистика доходов для админки и бота. Считаем в JS из оплаченных счетов
// (payments.paid_at), группировка по месяцам — в МСК. Деньги — копейки.
import { eq } from "drizzle-orm";
import { db } from "./db";
import { payments, students } from "./schema";
import { FREE_COLOR_ID, MISSED_COLOR_ID, MSK_OFFSET_MINUTES } from "./config";
import { isPackageKind, summarizeOutstanding } from "./payments";
import { fetchBusy, listDayOccurrences } from "./google";
import { buildWeek, weekWindowBounds, type DaySlots } from "./slots";

export interface IncomeStats {
  totalKopecks: number; // всего получено за всё время
  thisMonthKopecks: number; // за текущий месяц (МСК)
  prevMonthKopecks: number; // за прошлый месяц
  outstandingKopecks: number; // выставлено, но не оплачено (всего)
  // Разбор неоплаченного по смыслу: долг за проведённые занятия vs предоплата.
  debtKopecks: number; // счета за уже проведённые занятия + ручные
  advanceKopecks: number; // автосчета «вперёд» — предоплата, не задолженность
  packageOfferKopecks: number; // предложено оплатить вперёд одним платежом (пакет/месяц)
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

// ── Должники ───────────────────────────────────────────────────────────────
// Кто и сколько должен — одним экраном. Долг = счета за уже проведённые занятия
// и ручные счета преподавателя; аванс и предложенный пакет долгом не считаются
// (та же семантика, что в карточке ученика и аналитике).
export interface DebtorRow {
  studentId: string;
  name: string;
  subject: string;
  active: boolean;
  debtKopecks: number;
  advanceKopecks: number;
  packageKopecks: number;
  oldestAt: Date | null; // дата самого старого неоплаченного счёта-долга
  invoices: number; // сколько счетов-долгов открыто
}

// Чистая группировка (для тестов): неоплаченные счета × ученики → должники,
// от большего долга к меньшему. Ученики без долга не возвращаются.
export function groupDebtors(
  rows: { studentId: string; kind: string; amountKopecks: number; createdAt: Date | string | null }[],
  studentRows: { id: string; name: string; subject: string; active: boolean }[]
): DebtorRow[] {
  const byId = new Map(studentRows.map((s) => [s.id, s]));
  const acc = new Map<string, DebtorRow>();
  for (const r of rows) {
    const s = byId.get(r.studentId);
    if (!s) continue; // счёт без ученика (удалён) — в сводку не идёт
    const row =
      acc.get(r.studentId) ??
      {
        studentId: s.id,
        name: s.name,
        subject: s.subject,
        active: s.active,
        debtKopecks: 0,
        advanceKopecks: 0,
        packageKopecks: 0,
        oldestAt: null,
        invoices: 0,
      };
    if (isPackageKind(r.kind)) row.packageKopecks += r.amountKopecks;
    else if (r.kind === "advance") row.advanceKopecks += r.amountKopecks;
    else {
      row.debtKopecks += r.amountKopecks;
      row.invoices++;
      const at = r.createdAt ? new Date(r.createdAt) : null;
      if (at && (!row.oldestAt || at < row.oldestAt)) row.oldestAt = at;
    }
    acc.set(r.studentId, row);
  }
  return [...acc.values()]
    .filter((r) => r.debtKopecks > 0)
    .sort((a, b) => b.debtKopecks - a.debtKopecks);
}

export async function listDebtors(): Promise<DebtorRow[]> {
  const rows = await db()
    .select({
      studentId: payments.studentId,
      kind: payments.kind,
      amountKopecks: payments.amountKopecks,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(eq(payments.status, "unpaid"));
  const studentRows = await db()
    .select({
      id: students.id,
      name: students.name,
      subject: students.subject,
      active: students.active,
    })
    .from(students);
  return groupDebtors(rows, studentRows);
}

// ── Загрузка недели ────────────────────────────────────────────────────────
// Сколько слотов рабочей недели занято. Это потолок выручки в штуках: свободный
// слот — незаработанные деньги, поэтому свободные времена показываем списком.
export interface WeekLoad {
  total: number; // всего слотов в рабочей неделе
  busy: number;
  free: number;
  percent: number; // загрузка, 0–100
  freeByDay: { weekday: string; times: string[] }[]; // только дни, где есть свободное
}

export function summarizeWeekLoad(days: DaySlots[]): WeekLoad {
  let total = 0;
  let busy = 0;
  const freeByDay: { weekday: string; times: string[] }[] = [];
  for (const d of days) {
    if (d.closed) continue; // выходной — в ёмкость не входит
    const times: string[] = [];
    for (const s of d.slots) {
      total++;
      if (s.busy) busy++;
      else times.push(s.time);
    }
    if (times.length) freeByDay.push({ weekday: d.weekday, times });
  }
  const free = total - busy;
  return { total, busy, free, percent: total ? Math.round((busy / total) * 100) : 0, freeByDay };
}

export async function computeWeekLoad(now = new Date()): Promise<WeekLoad> {
  const { timeMin, timeMax } = weekWindowBounds(now);
  const busy = await fetchBusy(timeMin, timeMax);
  return summarizeWeekLoad(buildWeek(busy, now));
}
