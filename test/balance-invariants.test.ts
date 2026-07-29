// Инварианты раскладки баланса — не «на этом примере получилось 3 часа», а
// «ни на каких входных данных не может получиться неправды». fast-check гоняет
// сотни случайных раскладов занятий и оплат; ломается — печатает минимальный
// контрпример.
//
// Зачем: allocateBalance — единственный расчёт, из которого растут и покраска
// календаря, и автосчета, и кабинет. Ошибка здесь — это деньги, а точечные
// примеры покрывают только те случаи, которые пришли в голову.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateBalance } from "@/lib/balance";
import type { ColorOccurrence } from "@/lib/google";

const NOW = new Date("2026-07-12T09:00:00.000Z");

// Занятие: смещение в днях от «сейчас» (может быть отрицательным — прошедшее)
// и длина блока 1–3 часа.
const occArb = fc.record({
  dayOffset: fc.integer({ min: -40, max: 40 }),
  hours: fc.integer({ min: 1, max: 3 }),
});

// Список занятий, отсортированный по времени, — allocateBalance получает их
// только такими (listContactOccurrences сортирует).
const occurrencesArb = fc.array(occArb, { maxLength: 25 }).map((raw) =>
  raw
    .map((o, i) => ({
      instanceId: `i${i}`,
      // Разные минуты, чтобы одинаковые дни не совпадали по времени.
      start: new Date(NOW.getTime() + o.dayOffset * 86400000 + i * 60000),
      hours: o.hours,
      colorId: null,
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime()) as ColorOccurrence[]
);

const paidHoursArb = fc.integer({ min: 0, max: 60 });

describe("allocateBalance — инварианты (property-based)", () => {
  it("ни один час не теряется и не появляется из воздуха", () => {
    fc.assert(
      fc.property(occurrencesArb, paidHoursArb, (occ, paidHours) => {
        const { summary } = allocateBalance(occ, paidHours, NOW);
        // Купленные часы либо закрыли прошедшее, либо будущее, либо остались.
        expect(summary.pastPaidHours + summary.aheadHours + summary.leftoverHours).toBe(paidHours);
      })
    );
  });

  it("все итоги неотрицательны — долг не может быть «минусовым»", () => {
    fc.assert(
      fc.property(occurrencesArb, paidHoursArb, (occ, paidHours) => {
        const { summary } = allocateBalance(occ, paidHours, NOW);
        for (const v of [
          summary.pastPaidHours,
          summary.aheadHours,
          summary.leftoverHours,
          summary.debtHours,
        ]) {
          expect(v).toBeGreaterThanOrEqual(0);
        }
      })
    );
  });

  it("долг = ровно сумма часов прошедших незакрытых занятий", () => {
    fc.assert(
      fc.property(occurrencesArb, paidHoursArb, (occ, paidHours) => {
        const { items, summary } = allocateBalance(occ, paidHours, NOW);
        const debt = items.filter((i) => i.past && !i.paid).reduce((s, i) => s + i.hours, 0);
        expect(summary.debtHours).toBe(debt);
      })
    );
  });

  it("«всё-или-ничего»: после первого незакрытого занятия закрытых больше нет", () => {
    // Блок из N часов — одно событие и один цвет, поэтому перескок через
    // неоплаченный блок к более дешёвому следующему запрещён.
    fc.assert(
      fc.property(occurrencesArb, paidHoursArb, (occ, paidHours) => {
        const { items } = allocateBalance(occ, paidHours, NOW);
        const firstUnpaid = items.findIndex((i) => !i.paid);
        if (firstUnpaid === -1) return;
        expect(items.slice(firstUnpaid).every((i) => !i.paid)).toBe(true);
      })
    );
  });

  it("больше денег — не хуже: долг не растёт, закрытых занятий не становится меньше", () => {
    fc.assert(
      fc.property(occurrencesArb, paidHoursArb, fc.integer({ min: 1, max: 20 }), (occ, paid, add) => {
        const a = allocateBalance(occ, paid, NOW).summary;
        const b = allocateBalance(occ, paid + add, NOW).summary;
        expect(b.debtHours).toBeLessThanOrEqual(a.debtHours);
        expect(b.pastPaidHours + b.aheadHours).toBeGreaterThanOrEqual(a.pastPaidHours + a.aheadHours);
      })
    );
  });

  it("paidUntil — начало последнего закрытого занятия (или null, если закрытых нет)", () => {
    fc.assert(
      fc.property(occurrencesArb, paidHoursArb, (occ, paidHours) => {
        const { items, summary } = allocateBalance(occ, paidHours, NOW);
        const lastPaid = [...items].reverse().find((i) => i.paid);
        expect(summary.paidUntil).toBe(lastPaid ? lastPaid.start.toISOString() : null);
      })
    );
  });

  it("nextStart/nextPaid описывают именно ближайшее будущее занятие", () => {
    // На этих полях держится решение «выставлять ли счёт вперёд»: ошибка здесь —
    // либо ученик платит дважды, либо занятие уходит неоплаченным.
    fc.assert(
      fc.property(occurrencesArb, paidHoursArb, (occ, paidHours) => {
        const { items, summary } = allocateBalance(occ, paidHours, NOW);
        const next = items.find((i) => !i.past);
        expect(summary.nextStart).toBe(next ? next.start.toISOString() : null);
        expect(summary.nextPaid).toBe(next ? next.paid : false);
      })
    );
  });

  it("оплаченных часов хватает на все закрытые занятия", () => {
    fc.assert(
      fc.property(occurrencesArb, paidHoursArb, (occ, paidHours) => {
        const { items } = allocateBalance(occ, paidHours, NOW);
        const used = items.filter((i) => i.paid).reduce((s, i) => s + i.hours, 0);
        expect(used).toBeLessThanOrEqual(paidHours);
      })
    );
  });

  it("без оплат всё прошедшее — долг, будущее не закрыто", () => {
    fc.assert(
      fc.property(occurrencesArb, (occ) => {
        const { items, summary } = allocateBalance(occ, 0, NOW);
        expect(items.every((i) => !i.paid)).toBe(true);
        expect(summary.aheadHours).toBe(0);
        expect(summary.debtHours).toBe(
          occ.filter((o) => o.start < NOW).reduce((s, o) => s + o.hours, 0)
        );
      })
    );
  });
});
