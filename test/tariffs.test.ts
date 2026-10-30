import { describe, expect, it } from "vitest";
import { detectExamTariff } from "@/lib/config";
import { nextLessonCostKopecks, planAutoInvoices } from "@/lib/autobill";
import { packageLessonsOf, splitPaidHours } from "@/lib/payments";
import type { StudentBalance } from "@/lib/balance";

describe("detectExamTariff — тариф по предмету", () => {
  it("канонические предметы из прайса", () => {
    expect(detectExamTariff("ЕГЭ информатика")?.kind).toBe("ege");
    expect(detectExamTariff("ОГЭ информатика")?.kind).toBe("oge");
    expect(detectExamTariff(" егэ информатика ")?.kind).toBe("ege"); // регистр и пробелы
  });

  it("свободный текст, начинающийся с названия экзамена", () => {
    expect(detectExamTariff("ЕГЭ по информатике")?.kind).toBe("ege");
    expect(detectExamTariff("огэ")?.kind).toBe("oge");
  });

  it("обычный предмет — не экзаменационный", () => {
    expect(detectExamTariff("Питон")).toBeNull();
    expect(detectExamTariff("")).toBeNull();
  });

  it("упоминание экзамена внутри строки НЕ включает тариф", () => {
    // Предмет — свободный текст (в боте есть «Другое»). Раньше вхождение подстроки
    // молча включало ставку 2500 ₽, поштучный автосчёт и пакет.
    expect(detectExamTariff("Не ЕГЭ, просто информатика")).toBeNull();
    expect(detectExamTariff("Информатика кроме ОГЭ")).toBeNull();
    expect(detectExamTariff("Подготовка к ОГЭ по информатике")).toBeNull();
  });

  it("ставка совпадает с прайсом", () => {
    expect(detectExamTariff("ЕГЭ")!.hourlyKopecks).toBe(250000); // 2500 ₽
    expect(detectExamTariff("ОГЭ")!.hourlyKopecks).toBe(120000); // 1200 ₽
  });
});

// Минимальный баланс для nextLessonCostKopecks: важны items (past/paid/hours).
function bal(items: { past: boolean; paid: boolean; hours: number }[]): StudentBalance {
  return {
    rateKopecks: 250000,
    debtKopecks: 0,
    balanceKopecks: 0,
    paidHours: 0,
    pastPaidHours: 0,
    debtHours: 0,
    aheadHours: 0,
    leftoverHours: 0,
    paidUntil: null,
    nextStart: null,
    nextPaid: false,
    items: items.map((i) => ({
      ...i,
      instanceId: "x",
      start: new Date(),
      hours: i.hours,
      colorId: null,
      studentId: "s",
    })) as StudentBalance["items"],
  };
}

describe("nextLessonCostKopecks — «вперёд» = ровно одно ближайшее занятие", () => {
  it("берёт ближайшее будущее занятие × ставку", () => {
    const b = bal([
      { past: true, paid: false, hours: 1 }, // долг — считается отдельным счётом
      { past: false, paid: false, hours: 2 }, // ← ближайшее будущее
      { past: false, paid: false, hours: 1 },
    ]);
    expect(nextLessonCostKopecks(b)).toBe(500000);
  });

  it("ближайшее занятие уже оплачено — счёта «вперёд» нет", () => {
    // Ученик заплатил вперёд: нельзя перескакивать через оплаченное занятие и
    // выставлять счёт на следующее — иначе оплата вперёд ничего не меняет.
    const b = bal([
      { past: false, paid: true, hours: 1 },
      { past: false, paid: false, hours: 1 },
    ]);
    expect(nextLessonCostKopecks(b)).toBe(0);
  });

  it("нет будущих занятий — 0", () => {
    expect(nextLessonCostKopecks(bal([{ past: true, paid: false, hours: 1 }]))).toBe(0);
  });
});

describe("packageLessonsOf — число занятий старого пакета хранится в самом счёте", () => {
  it("kind несёт число занятий", () => {
    expect(packageLessonsOf("package:8")).toBe(8);
  });

  it("строка без числа и обычные счета — 0 (считаются деньгами)", () => {
    expect(packageLessonsOf("package")).toBe(0);
    expect(packageLessonsOf("manual")).toBe(0);
    expect(packageLessonsOf("advance")).toBe(0);
  });
});

describe("splitPaidHours — оплаченные часы", () => {
  it("обычные оплаты — деньги÷ставку, остаток копеек не теряется", () => {
    expect(splitPaidHours([{ amount: 250000, kind: "debt" }, { amount: 100000, kind: "manual" }], 120000)).toEqual({
      paidHours: 2, // 3 500 ₽ / 1 200 ₽ = 2 полных часа
      moneyKopecks: 350000,
      packageHours: 0,
      packageKopecks: 0,
    });
  });

  it("старый оплаченный пакет кредитует свои часы, а не деньги÷ставку", () => {
    expect(splitPaidHours([{ amount: 816000, kind: "package:8" }, { amount: 120000, kind: "advance" }], 120000)).toEqual({
      paidHours: 9, // 8 по пакету + 1 за аванс
      moneyKopecks: 120000,
      packageHours: 8,
      packageKopecks: 816000,
    });
  });

  it("пакет без числа занятий — обычные деньги", () => {
    expect(splitPaidHours([{ amount: 240000, kind: "package" }], 120000).paidHours).toBe(2);
  });
});

describe("planAutoInvoices — ручные счета", () => {
  it("обычный ручной счёт гасит долг", () => {
    const actions = planAutoInvoices({
      debtKopecks: 250000,
      advanceKopecks: 0,
      openInvoices: [{ id: "m", kind: "manual", amountKopecks: 250000 }],
    });
    expect(actions).toEqual([]); // долг покрыт ручным счётом
  });
});
