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
import type { Student } from "./schema";
import { paidHoursBreakdown } from "./payments";
import { detectExamTariff, FREE_COLOR_ID, MISSED_COLOR_ID } from "./config";

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
  nextStart: string | null; // ISO ближайшего будущего занятия (null — впереди пусто)
  nextPaid: boolean; // это ближайшее занятие уже закрыто балансом
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
    nextStart: null,
    nextPaid: false,
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
    // Ближайшее будущее занятие и его оплаченность — по нему решается, надо ли
    // выставлять счёт «вперёд» и что показать в кабинете («занятие уже оплачено»).
    if (!past && summary.nextStart === null) {
      summary.nextStart = o.start.toISOString();
      summary.nextPaid = paid;
    }
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

// preloaded — уже загруженная строка ученика (кабинет и автосчета читают её один раз
// и передают сюда, чтобы не ходить в БД за тем же самым по три раза за запрос).
export async function computeStudentBalance(
  studentId: string,
  preloaded?: Student | null
): Promise<StudentBalance | null> {
  const s = preloaded !== undefined ? preloaded : await getStudent(studentId);
  // Пробное занятие бесплатное, поэтому у пробного ученика баланса нет вообще —
  // даже если ставка уже проставлена (её спрашивают при заведении ученика в боте
  // ещё до выбора «пробное / регулярное»). Иначе кабинет показывал бы счёт на
  // занятие, за которое платить не надо. Биллинг включается переводом в
  // полноценные (promoteStudentToFull), где прошедшее пробное помечается бесплатным.
  if (!s || s.trial || s.rateKopecks <= 0) return null;
  // Пакетные оплаты (месяц ОГЭ/ЕГЭ) кредитуют фиксированные часы, а не деньги÷ставку.
  const packageLessons = detectExamTariff(s.subject)?.packageLessons ?? 0;
  const { paidHours, moneyKopecks, packageKopecks } = await paidHoursBreakdown(
    s.id,
    s.rateKopecks,
    packageLessons
  );
  // Пропущенные (серые) и бесплатные (пробные) занятия не тарифицируются.
  const occ = (await listContactOccurrences(s.contactKey)).filter((o) => !isUntariffed(o.colorId));
  const { items, summary } = allocateBalance(occ, paidHours, new Date());
  // Остаток на балансе = все полученные деньги (включая пакетные) минус стоимость
  // уже разложенных на занятия часов по ставке. Пакетные часы НЕ оцениваем по полной
  // ставке: пакет со скидкой 18 000 ₽ должен показывать 18 000 ₽ остатка, а не 20 000 ₽.
  return {
    ...summary,
    items,
    rateKopecks: s.rateKopecks,
    debtKopecks: summary.debtHours * s.rateKopecks,
    balanceKopecks: moneyKopecks + packageKopecks - (paidHours - summary.leftoverHours) * s.rateKopecks,
  };
}
