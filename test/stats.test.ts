import { describe, expect, it } from "vitest";
import { expectedIncome, summarizeIncome } from "@/lib/stats";

// «Сейчас»: 14 июля 2026 (МСК).
const NOW = new Date("2026-07-14T09:00:00.000Z");

describe("summarizeIncome — сводка доходов", () => {
  it("суммирует по месяцам (МСК), считает текущий/прошлый/итого и долг", () => {
    const s = summarizeIncome({
      paid: [
        { amount: 600000, paidAt: "2026-07-05T10:00:00.000Z" }, // июль
        { amount: 150000, paidAt: "2026-07-20T10:00:00.000Z" }, // июль
        { amount: 300000, paidAt: "2026-06-15T10:00:00.000Z" }, // июнь
      ],
      unpaid: [{ amount: 450000 }, { amount: 150000 }],
      studentsActive: [true, true, false, true],
      now: NOW,
    });
    expect(s.thisMonthKopecks).toBe(750000);
    expect(s.prevMonthKopecks).toBe(300000);
    expect(s.totalKopecks).toBe(1050000);
    expect(s.outstandingKopecks).toBe(600000);
    expect(s.activeStudents).toBe(3);
    expect(s.paidCount).toBe(3);
  });

  it("6 месяцев в графике, последний — текущий; оплата без даты идёт только в total", () => {
    const s = summarizeIncome({
      paid: [{ amount: 100000, paidAt: null }],
      unpaid: [],
      studentsActive: [],
      now: NOW,
    });
    expect(s.byMonth).toHaveLength(6);
    expect(s.byMonth.at(-1)).toEqual({ label: "июл", kopecks: 0 }); // текущий месяц
    expect(s.byMonth[0].label).toBe("фев"); // июль минус 5 = февраль
    expect(s.totalKopecks).toBe(100000); // в total попала, в месяцы — нет
    expect(s.thisMonthKopecks).toBe(0);
  });

  it("пусто — все нули, график из 6 месяцев", () => {
    const s = summarizeIncome({ paid: [], unpaid: [], studentsActive: [], now: NOW });
    expect(s).toMatchObject({ totalKopecks: 0, outstandingKopecks: 0, activeStudents: 0, paidCount: 0 });
    expect(s.byMonth.every((m) => m.kopecks === 0)).toBe(true);
    expect(s.expectedMonthKopecks).toBeNull(); // календарь не считали
  });

  it("ожидаемый доход прокидывается в сводку", () => {
    const s = summarizeIncome({
      paid: [],
      unpaid: [],
      studentsActive: [],
      expectedMonthKopecks: 900000,
      now: NOW,
    });
    expect(s.expectedMonthKopecks).toBe(900000);
  });
});

describe("expectedIncome — ожидаемый доход за месяц по расписанию", () => {
  const rates = new Map([
    ["s1", 150000], // 1500 ₽/час
    ["s2", 200000], // 2000 ₽/час
  ]);

  it("часы занятий × ставка ученика, блоки считаются целиком", () => {
    const total = expectedIncome(
      [
        { hours: 1, colorId: null, studentId: "s1" },
        { hours: 2, colorId: null, studentId: "s1" }, // блок из двух часов
        { hours: 1, colorId: "10", studentId: "s2" }, // оплаченное прошедшее — тоже в плане месяца
      ],
      rates
    );
    expect(total).toBe(150000 * 3 + 200000);
  });

  it("пропуски (серые) и бесплатные (Sage) не считаются", () => {
    const total = expectedIncome(
      [
        { hours: 1, colorId: "8", studentId: "s1" }, // пропуск
        { hours: 1, colorId: "2", studentId: "s1" }, // бесплатное пробное
        { hours: 1, colorId: null, studentId: "s1" },
      ],
      rates
    );
    expect(total).toBe(150000);
  });

  it("ученик без ставки даёт 0 (не ломает подсчёт)", () => {
    const total = expectedIncome([{ hours: 3, colorId: null, studentId: "нет-такого" }], rates);
    expect(total).toBe(0);
  });
});
