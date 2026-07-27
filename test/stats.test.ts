import { describe, expect, it } from "vitest";
import { expectedIncome, groupDebtors, summarizeIncome, summarizeWeekLoad } from "@/lib/stats";

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
      unpaid: [
        { amount: 450000, kind: "debt" },
        { amount: 150000, kind: "manual" },
      ],
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

  it("долгом считаются только счета за проведённые: аванс и пакет — отдельно", () => {
    const s = summarizeIncome({
      paid: [],
      unpaid: [
        { amount: 300000, kind: "debt" }, // долг за проведённые
        { amount: 100000, kind: "manual" }, // ручной счёт — тоже обязательство
        { amount: 250000, kind: "advance" }, // предоплата за следующее занятие
        { amount: 1800000, kind: "package:8" }, // предложение пакета
      ],
      studentsActive: [],
      now: NOW,
    });
    expect(s.debtKopecks).toBe(400000);
    expect(s.advanceKopecks).toBe(250000);
    expect(s.packageOfferKopecks).toBe(1800000);
    expect(s.outstandingKopecks).toBe(2450000); // всего выставлено — по-прежнему сумма
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

describe("groupDebtors — кто и сколько должен", () => {
  const studentRows = [
    { id: "s1", name: "Аня", subject: "Питон", active: true },
    { id: "s2", name: "Боря", subject: "ЕГЭ информатика", active: true },
    { id: "s3", name: "Вика", subject: "Фронтенд", active: false },
  ];

  it("долгом считаются счета за проведённые и ручные; аванс и пакет — нет", () => {
    const rows = groupDebtors(
      [
        { studentId: "s1", kind: "debt", amountKopecks: 300000, createdAt: "2026-07-01T10:00:00Z" },
        { studentId: "s1", kind: "manual", amountKopecks: 100000, createdAt: "2026-07-05T10:00:00Z" },
        { studentId: "s2", kind: "advance", amountKopecks: 250000, createdAt: null },
        { studentId: "s2", kind: "package:8", amountKopecks: 1700000, createdAt: null },
      ],
      studentRows
    );
    // У Бори только аванс и пакет — он не должник.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Аня", debtKopecks: 400000, invoices: 2 });
    // Возраст долга — по самому старому счёту.
    expect(rows[0].oldestAt?.toISOString()).toBe("2026-07-01T10:00:00.000Z");
  });

  it("сортировка по убыванию долга, архивные тоже видны", () => {
    const rows = groupDebtors(
      [
        { studentId: "s1", kind: "debt", amountKopecks: 100000, createdAt: null },
        { studentId: "s3", kind: "debt", amountKopecks: 900000, createdAt: null },
      ],
      studentRows
    );
    expect(rows.map((r) => r.name)).toEqual(["Вика", "Аня"]);
    expect(rows[0].active).toBe(false);
  });

  it("счёт удалённого ученика игнорируется", () => {
    const rows = groupDebtors(
      [{ studentId: "нет-такого", kind: "debt", amountKopecks: 500000, createdAt: null }],
      studentRows
    );
    expect(rows).toHaveLength(0);
  });
});

describe("summarizeWeekLoad — загрузка недели", () => {
  const day = (weekday: string, slots: [string, boolean][], closed = false) => ({
    date: `wd-${weekday}`,
    title: weekday,
    weekday,
    closed,
    slots: slots.map(([time, busy]) => ({ start: `2026-07-14T07:00:00.000Z`, time, busy })),
  });

  it("считает занятые/свободные и собирает свободные времена по дням", () => {
    const load = summarizeWeekLoad([
      day("Пн", [["10:00", true], ["11:10", false]]),
      day("Вт", [["09:00", true], ["10:10", true]]),
      day("Пт", [], true), // выходной — в ёмкость не входит
    ]);
    expect(load).toMatchObject({ total: 4, busy: 3, free: 1, percent: 75 });
    expect(load.freeByDay).toEqual([{ weekday: "Пн", times: ["11:10"] }]);
  });

  it("пустое расписание не делит на ноль", () => {
    expect(summarizeWeekLoad([])).toMatchObject({ total: 0, percent: 0, freeByDay: [] });
  });
});
