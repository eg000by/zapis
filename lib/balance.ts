// Балансовая модель оплат — единый источник правды для покраски календаря,
// плашки баланса в кабинете ученика и автосчетов.
//
// «Оплачено занятий» = сумма оплаченных счетов ÷ ставка ₽/час. Этим числом
// закрываем занятия ученика по времени, с самых ранних. Блок из N подряд часов —
// одно событие и один цвет, поэтому «всё-или-ничего»: блок оплачен, только если
// остатка хватает на ВСЮ его длину; как только не хватило — дальше всё неоплачено
// (без перескока через большой блок к меньшему).
import { listContactOccurrences, type ColorOccurrence } from "./google";
import { getStudent } from "./students";
import { sumPaidKopecks } from "./payments";
import { FREE_COLOR_ID, MISSED_COLOR_ID } from "./config";

// Занятия, исключённые из тарификации: пропуск (серый) и бесплатное (пробное).
const isUntariffed = (colorId: string | null) =>
  colorId === MISSED_COLOR_ID || colorId === FREE_COLOR_ID;

export interface AllocatedOccurrence extends ColorOccurrence {
  paid: boolean; // закрыто балансом
  past: boolean; // занятие уже началось
}

export interface BalanceSummary {
  paidHours: number; // всего часов куплено (floor суммы ÷ ставка)
  pastPaidHours: number; // проведено и оплачено
  debtHours: number; // проведено, но НЕ оплачено (долг)
  aheadHours: number; // будущие занятия, закрытые балансом (оплачено вперёд)
  leftoverHours: number; // куплено, но не разложено ни на одно известное занятие
  paidUntil: string | null; // ISO начала последнего закрытого балансом занятия
}

// Чистый проход: раскладывает paidHours по занятиям (по возрастанию времени).
export function allocateBalance(
  occurrences: ColorOccurrence[],
  paidHours: number,
  now: Date
): { items: AllocatedOccurrence[]; summary: BalanceSummary } {
  const items: AllocatedOccurrence[] = [];
  const summary: BalanceSummary = {
    paidHours,
    pastPaidHours: 0,
    debtHours: 0,
    aheadHours: 0,
    leftoverHours: 0,
    paidUntil: null,
  };
  let remaining = paidHours;
  let exhausted = false;
  for (const o of occurrences) {
    let paid = false;
    if (!exhausted && remaining >= o.hours) {
      paid = true;
      remaining -= o.hours;
    } else {
      exhausted = true;
    }
    const past = o.start.getTime() < now.getTime();
    if (paid) {
      if (past) summary.pastPaidHours += o.hours;
      else summary.aheadHours += o.hours;
      summary.paidUntil = o.start.toISOString();
    } else if (past) {
      summary.debtHours += o.hours;
    }
    items.push({ ...o, paid, past });
  }
  summary.leftoverHours = remaining;
  return { items, summary };
}

// Баланс ученика в деньгах — для кабинета и автосчетов. null, если ученика нет
// или ставка не задана (без ставки «оплаченные занятия» не посчитать — не пугаем
// ложным долгом).
export interface StudentBalance extends BalanceSummary {
  rateKopecks: number;
  debtKopecks: number; // долг в деньгах (часы долга × ставка)
  // Остаток на балансе: деньги сверх всех известных занятий (нераспределённые
  // целые часы + неполный «хвост» от деления суммы на ставку).
  balanceKopecks: number;
  items: AllocatedOccurrence[];
}

export async function computeStudentBalance(studentId: string): Promise<StudentBalance | null> {
  const s = await getStudent(studentId);
  if (!s || s.rateKopecks <= 0) return null;
  const paidKopecks = await sumPaidKopecks(s.id);
  const paidHours = Math.floor(paidKopecks / s.rateKopecks);
  // Пропущенные (серые) и бесплатные (пробные) занятия не тарифицируются.
  const occ = (await listContactOccurrences(s.contactKey)).filter((o) => !isUntariffed(o.colorId));
  const { items, summary } = allocateBalance(occ, paidHours, new Date());
  return {
    ...summary,
    items,
    rateKopecks: s.rateKopecks,
    debtKopecks: summary.debtHours * s.rateKopecks,
    balanceKopecks:
      summary.leftoverHours * s.rateKopecks + (paidKopecks - paidHours * s.rateKopecks),
  };
}
