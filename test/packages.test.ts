import { describe, expect, it } from "vitest";
import { detectExamTariff, packageSavings, EXAM_TARIFFS } from "@/lib/config";
import { nextLessonCostKopecks, planAutoInvoices } from "@/lib/autobill";
import type { StudentBalance } from "@/lib/balance";

describe("detectExamTariff — тариф по предмету", () => {
  it("ЕГЭ и ОГЭ по вхождению в название предмета", () => {
    expect(detectExamTariff("ЕГЭ информатика")?.kind).toBe("ege");
    expect(detectExamTariff("Подготовка к ОГЭ по информатике")?.kind).toBe("oge");
    expect(detectExamTariff("огэ")?.kind).toBe("oge"); // регистр не важен
  });

  it("обычный предмет — не экзаменационный", () => {
    expect(detectExamTariff("Питон")).toBeNull();
    expect(detectExamTariff("")).toBeNull();
  });

  it("ставка и цена пакета совпадают с прайсом", () => {
    const ege = detectExamTariff("ЕГЭ")!;
    expect(ege.hourlyKopecks).toBe(250000); // 2500 ₽
    expect(ege.packageKopecks).toBe(1800000); // 18 000 ₽
    const oge = detectExamTariff("ОГЭ")!;
    expect(oge.hourlyKopecks).toBe(120000); // 1200 ₽
    expect(oge.packageKopecks).toBe(860000); // 8 600 ₽
  });
});

describe("packageSavings — выгода месячного пакета", () => {
  it("ЕГЭ: 8×2500=20000 − 18000 = 2000 (10%)", () => {
    const s = packageSavings(EXAM_TARIFFS.find((t) => t.kind === "ege")!);
    expect(s.kopecks).toBe(200000);
    expect(s.percent).toBe(10);
  });

  it("ОГЭ: 8×1200=9600 − 8600 = 1000 (~10%)", () => {
    const s = packageSavings(EXAM_TARIFFS.find((t) => t.kind === "oge")!);
    expect(s.kopecks).toBe(100000);
    expect(s.percent).toBe(10);
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

describe("nextLessonCostKopecks — «вперёд» для экзаменационных = одно занятие", () => {
  it("берёт первое будущее неоплаченное занятие × ставку", () => {
    const b = bal([
      { past: true, paid: false, hours: 1 }, // долг — пропускаем
      { past: false, paid: true, hours: 1 }, // будущее оплаченное — пропускаем
      { past: false, paid: false, hours: 1 }, // ← это
      { past: false, paid: false, hours: 1 },
    ]);
    expect(nextLessonCostKopecks(b)).toBe(250000);
  });

  it("нет будущих неоплаченных — 0", () => {
    expect(nextLessonCostKopecks(bal([{ past: true, paid: false, hours: 1 }]))).toBe(0);
  });
});

describe("planAutoInvoices — пакетный оффер не гасит поштучные счета", () => {
  it("неоплаченный package не входит в billedManual (долг остаётся)", () => {
    const actions = planAutoInvoices({
      debtKopecks: 250000,
      advanceKopecks: 250000,
      openInvoices: [{ id: "pkg", kind: "package", amountKopecks: 1800000 }],
    });
    // Пакет игнорируется как «уже выставленный» — оба автосчёта создаются.
    expect(actions).toEqual([
      { action: "create", kind: "debt", amountKopecks: 250000 },
      { action: "create", kind: "advance", amountKopecks: 250000 },
    ]);
  });

  it("обычный ручной счёт по-прежнему гасит долг", () => {
    const actions = planAutoInvoices({
      debtKopecks: 250000,
      advanceKopecks: 0,
      openInvoices: [{ id: "m", kind: "manual", amountKopecks: 250000 }],
    });
    expect(actions).toEqual([]); // долг покрыт ручным счётом
  });
});
