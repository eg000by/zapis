import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceCostKopecks,
  ensureAutoInvoices,
  planAutoInvoices,
} from "@/lib/autobill";
import { computeStudentBalance } from "@/lib/balance";
import {
  createPayment,
  deletePayment,
  outstandingPayments,
  updatePayment,
} from "@/lib/payments";
import { createYkPayment, yookassaConfigured } from "@/lib/yookassa";

vi.mock("@/lib/balance", () => ({ computeStudentBalance: vi.fn(async () => null) }));
vi.mock("@/lib/payments", () => ({
  createPayment: vi.fn(async () => ({ id: "new" })),
  deletePayment: vi.fn(async () => {}),
  updatePayment: vi.fn(async () => {}),
  outstandingPayments: vi.fn(async () => []),
}));
vi.mock("@/lib/yookassa", () => ({
  yookassaConfigured: vi.fn(() => false),
  createYkPayment: vi.fn(async () => ({ id: "yk-1", confirmationUrl: "https://yk/pay" })),
}));

const NOW = new Date("2026-07-12T09:00:00.000Z");

describe("planAutoInvoices — чистый планировщик", () => {
  it("нечего выставлять — нет действий", () => {
    expect(planAutoInvoices({ debtKopecks: 0, advanceKopecks: 0, openInvoices: [] })).toEqual([]);
  });

  it("создаёт ОТДЕЛЬНЫЕ счета на долг и на месяц вперёд", () => {
    expect(
      planAutoInvoices({ debtKopecks: 300000, advanceKopecks: 450000, openInvoices: [] })
    ).toEqual([
      { action: "create", kind: "debt", amountKopecks: 300000 },
      { action: "create", kind: "advance", amountKopecks: 450000 },
    ]);
  });

  it("суммы сошлись — счета не трогаются (идемпотентность)", () => {
    expect(
      planAutoInvoices({
        debtKopecks: 300000,
        advanceKopecks: 450000,
        openInvoices: [
          { id: "d1", kind: "debt", amountKopecks: 300000 },
          { id: "a1", kind: "advance", amountKopecks: 450000 },
        ],
      })
    ).toEqual([]);
  });

  it("сумма изменилась — счёт обновляется", () => {
    expect(
      planAutoInvoices({
        debtKopecks: 450000,
        advanceKopecks: 0,
        openInvoices: [{ id: "d1", kind: "debt", amountKopecks: 300000 }],
      })
    ).toEqual([{ action: "update", id: "d1", kind: "debt", amountKopecks: 450000 }]);
  });

  it("долг погашен — автосчёт снимается", () => {
    expect(
      planAutoInvoices({
        debtKopecks: 0,
        advanceKopecks: 0,
        openInvoices: [{ id: "d1", kind: "debt", amountKopecks: 300000 }],
      })
    ).toEqual([{ action: "delete", id: "d1", kind: "debt" }]);
  });

  it("ручной неоплаченный счёт уменьшает автосчета: сперва долг, остаток — «вперёд»", () => {
    // Ручной на 5 000 ₽ при долге 3 000 ₽: долг закрыт, из «вперёд» вычтено 2 000 ₽.
    expect(
      planAutoInvoices({
        debtKopecks: 300000,
        advanceKopecks: 450000,
        openInvoices: [{ id: "m1", kind: "manual", amountKopecks: 500000 }],
      })
    ).toEqual([{ action: "create", kind: "advance", amountKopecks: 250000 }]);
  });

  it("дубли одного вида (гонка) — лишние удаляются", () => {
    expect(
      planAutoInvoices({
        debtKopecks: 300000,
        advanceKopecks: 0,
        openInvoices: [
          { id: "d1", kind: "debt", amountKopecks: 300000 },
          { id: "d2", kind: "debt", amountKopecks: 300000 },
        ],
      })
    ).toEqual([{ action: "delete", id: "d2", kind: "debt" }]);
  });
});

describe("advanceCostKopecks — окно «месяц вперёд»", () => {
  it("считает только будущие незакрытые занятия в пределах окна", () => {
    const mk = (daysFromNow: number, paid: boolean, past = false, hours = 1) => ({
      instanceId: "i",
      start: new Date(NOW.getTime() + daysFromNow * 86400000),
      hours,
      colorId: null,
      paid,
      past,
    });
    const balance = {
      rateKopecks: 150000,
      items: [
        mk(-3, false, true), // прошлое (долг) — не в окне «вперёд»
        mk(2, true), // будущее, уже оплачено — не выставляем
        mk(9, false), // будущее, не оплачено → в счёт
        mk(16, false, false, 2), // блок 2 часа → в счёт
        mk(40, false), // за пределами 30 дней — не в счёт
      ],
    } as any;
    expect(advanceCostKopecks(balance, NOW)).toBe(3 * 150000);
  });
});

describe("ensureAutoInvoices — применение к счетам", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(NOW);
    vi.mocked(computeStudentBalance).mockResolvedValue(null);
    vi.mocked(outstandingPayments).mockResolvedValue([]);
    vi.mocked(yookassaConfigured).mockReturnValue(false);
    vi.mocked(createYkPayment).mockResolvedValue({
      id: "yk-1",
      confirmationUrl: "https://yk/pay",
    } as any);
  });

  function mockBalance(over: Partial<Record<string, unknown>> = {}) {
    vi.mocked(computeStudentBalance).mockResolvedValue({
      rateKopecks: 150000,
      debtKopecks: 300000,
      debtHours: 2,
      aheadHours: 0,
      leftoverHours: 0,
      paidHours: 0,
      pastPaidHours: 0,
      paidUntil: null,
      items: [],
      ...over,
    } as any);
  }

  it("нет ставки — ничего не делает", async () => {
    expect(await ensureAutoInvoices("stu-1", "Тест")).toBeNull();
    expect(createPayment).not.toHaveBeenCalled();
  });

  it("создаёт счёт на долг с человекочитаемой заметкой", async () => {
    mockBalance();
    await ensureAutoInvoices("stu-1", "Тест");
    expect(createPayment).toHaveBeenCalledWith({
      studentId: "stu-1",
      amountKopecks: 300000,
      kind: "debt",
      note: "Автосчёт: долг за проведённые занятия (2 ч)",
    });
  });

  it("обновление суммы сбрасывает ссылку оплаты (старый платёж ЮKassa неактуален)", async () => {
    mockBalance({ debtKopecks: 450000, debtHours: 3 });
    vi.mocked(outstandingPayments).mockResolvedValue([
      { id: "d1", kind: "debt", amountKopecks: 300000, payLink: "https://old" },
    ] as any);
    await ensureAutoInvoices("stu-1", "Тест");
    expect(updatePayment).toHaveBeenCalledWith("d1", {
      amountKopecks: 450000,
      note: "Автосчёт: долг за проведённые занятия (3 ч)",
      payLink: "",
      providerPaymentId: "",
    });
  });

  it("долг погашен — автосчёт удаляется, ручной счёт не трогается", async () => {
    mockBalance({ debtKopecks: 0, debtHours: 0 });
    vi.mocked(outstandingPayments).mockResolvedValue([
      { id: "d1", kind: "debt", amountKopecks: 300000, payLink: "" },
      { id: "m1", kind: "manual", amountKopecks: 100000, payLink: "" },
    ] as any);
    await ensureAutoInvoices("stu-1", "Тест");
    expect(deletePayment).toHaveBeenCalledTimes(1);
    expect(deletePayment).toHaveBeenCalledWith("d1");
  });

  it("с ЮKassa выдаёт ссылки всем счетам без ссылки — ручным тоже, занятые не трогает", async () => {
    mockBalance({ debtKopecks: 0, debtHours: 0 });
    vi.mocked(yookassaConfigured).mockReturnValue(true);
    vi.mocked(outstandingPayments).mockResolvedValue([
      { id: "m1", kind: "manual", amountKopecks: 100000, payLink: "" },
      { id: "m2", kind: "manual", amountKopecks: 200000, payLink: "https://мойналог" },
    ] as any);
    await ensureAutoInvoices("stu-1", "Тест");
    expect(createYkPayment).toHaveBeenCalledTimes(1);
    expect(createYkPayment).toHaveBeenCalledWith({
      ourPaymentId: "m1",
      amountKopecks: 100000,
      // Разделитель тысяч — неразрывный пробел локали ru-RU.
      description: `Оплата занятий: Тест — ${(1000).toLocaleString("ru-RU")} ₽`,
    });
    expect(updatePayment).toHaveBeenCalledWith("m1", {
      payLink: "https://yk/pay",
      providerPaymentId: "yk-1",
    });
  });

  it("падение ЮKassa не ломает кабинет (best-effort)", async () => {
    mockBalance({ debtKopecks: 0, debtHours: 0 });
    vi.mocked(yookassaConfigured).mockReturnValue(true);
    vi.mocked(createYkPayment).mockRejectedValue(new Error("500"));
    vi.mocked(outstandingPayments).mockResolvedValue([
      { id: "m1", kind: "manual", amountKopecks: 100000, payLink: "" },
    ] as any);
    await expect(ensureAutoInvoices("stu-1", "Тест")).resolves.not.toBeNull();
  });
});
