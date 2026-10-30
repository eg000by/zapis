import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAutoInvoices, planAutoInvoices } from "@/lib/autobill";
import { computeStudentBalance } from "@/lib/balance";
import {
  createPayment,
  deletePayment,
  outstandingPayments,
  updatePayment,
} from "@/lib/payments";
import { createYkPayment, yookassaConfigured } from "@/lib/yookassa";

vi.mock("@/lib/balance", () => ({ computeStudentBalance: vi.fn(async () => null) }));
vi.mock("@/lib/payments", () => {
  return {
    createPayment: vi.fn(async () => ({ id: "new" })),
    deletePayment: vi.fn(async () => {}),
    updatePayment: vi.fn(async () => {}),
    outstandingPayments: vi.fn(async () => []),
  };
});
vi.mock("@/lib/yookassa", () => ({
  yookassaConfigured: vi.fn(() => false),
  createYkPayment: vi.fn(async () => ({ id: "yk-1", confirmationUrl: "https://yk/pay" })),
}));
// Уведомления ученику о счетах — транспорт, к планировщику не относится: глушим.
vi.mock("@/lib/students", () => ({ getStudent: vi.fn(async () => null) }));
vi.mock("@/lib/notify", () => ({ notifyStudent: vi.fn(async () => {}) }));
vi.mock("@/lib/settings", () => ({
  getPayMethod: vi.fn(async () => "yookassa"),
  getSbpDetails: vi.fn(async () => "Перевод по СБП на номер …"),
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

const mk = (daysFromNow: number, paid: boolean, past = false, hours = 1) => ({
  instanceId: "i",
  start: new Date(NOW.getTime() + daysFromNow * 86400000),
  hours,
  colorId: null,
  paid,
  past,
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

  // Пробное занятие бесплатное — в кабинете такого ученика счёта быть не может.
  // На проде счета всё же появлялись: ставку в боте спрашивают до выбора
  // «пробное / регулярное», и она включала биллинг.
  it("пробному ученику счетов не выставляет, а старые автосчета снимает", async () => {
    mockBalance();
    vi.mocked(outstandingPayments).mockResolvedValue([
      { id: "d1", kind: "debt", amountKopecks: 300000, payLink: "" },
      { id: "a1", kind: "advance", amountKopecks: 150000, payLink: "" },
      { id: "m1", kind: "manual", amountKopecks: 100000, payLink: "" },
    ] as any);

    const trial = { id: "stu-1", trial: true, rateKopecks: 150000 } as any;
    expect(await ensureAutoInvoices("stu-1", "Тест", trial)).toBeNull();

    expect(createPayment).not.toHaveBeenCalled();
    expect(updatePayment).not.toHaveBeenCalled();
    // Ручной счёт выставил преподаватель осознанно — его не трогаем.
    expect(vi.mocked(deletePayment).mock.calls.map((c) => c[0])).toEqual(["d1", "a1"]);
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

  it("обычному ученику: счёт на ОДНО следующее занятие и ничего сверх", async () => {
    mockBalance({
      debtKopecks: 0,
      debtHours: 0,
      items: [mk(2, false), mk(9, false), mk(16, false)],
    });
    await ensureAutoInvoices("stu-1", "Тест");

    expect(createPayment).toHaveBeenCalledWith({
      studentId: "stu-1",
      amountKopecks: 150000,
      kind: "advance",
      note: "Автосчёт: следующее занятие (1 ч)",
    });
    // Предложения «оплатить вперёд одним платежом» больше нет.
    expect(createPayment).toHaveBeenCalledTimes(1);
  });

  it("экзаменационному ученику пакет со скидкой не выставляется", async () => {
    mockBalance({
      debtKopecks: 0,
      debtHours: 0,
      items: [mk(2, false), mk(9, false)],
    });
    const ege = { id: "stu-1", subject: "ЕГЭ информатика", rateKopecks: 150000 } as any;
    await ensureAutoInvoices("stu-1", "Милена", ege);

    expect(createPayment).toHaveBeenCalledTimes(1);
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ kind: "advance" }));
  });

  it("ученик в архиве: «вперёд» снимается, долг остаётся", async () => {
    mockBalance({ debtKopecks: 120000, debtHours: 1, items: [mk(-3, false, true), mk(2, false)] });
    vi.mocked(outstandingPayments).mockResolvedValue([
      { id: "a1", kind: "advance", amountKopecks: 120000, payLink: "" },
    ] as any);
    const archived = { id: "stu-1", subject: "ОГЭ информатика", rateKopecks: 120000, active: false } as any;
    await ensureAutoInvoices("stu-1", "Дима", archived);

    expect(vi.mocked(deletePayment).mock.calls.map((c) => c[0])).toEqual(["a1"]);
    expect(createPayment).toHaveBeenCalledTimes(1);
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ kind: "debt", amountKopecks: 120000 }));
  });

  it("ближайшее занятие оплачено вперёд — счёт «вперёд» снимается, нового нет", async () => {
    // Именно это ломалось на проде: ученик оплачивал занятие вперёд и в ту же
    // секунду получал счёт на занятие ПОСЛЕ него — состояние «всё оплачено»
    // не наступало никогда.
    mockBalance({
      debtKopecks: 0,
      debtHours: 0,
      aheadHours: 1,
      items: [mk(2, true), mk(9, false), mk(16, false)],
    });
    vi.mocked(outstandingPayments).mockResolvedValue([
      { id: "a1", kind: "advance", amountKopecks: 150000, payLink: "" },
    ] as any);
    await ensureAutoInvoices("stu-1", "Тест");

    expect(deletePayment).toHaveBeenCalledWith("a1");
    expect(createPayment).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "advance" })
    );
    expect(createPayment).not.toHaveBeenCalled();
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

  it("режим «СБП-перевод»: ссылки ЮKassa не создаются даже при настроенных ключах", async () => {
    const { getPayMethod } = await import("@/lib/settings");
    vi.mocked(getPayMethod).mockResolvedValueOnce("sbp");
    mockBalance({ debtKopecks: 0, debtHours: 0 });
    vi.mocked(yookassaConfigured).mockReturnValue(true);
    vi.mocked(outstandingPayments).mockResolvedValue([
      { id: "m1", kind: "manual", amountKopecks: 100000, payLink: "" },
    ] as any);
    await ensureAutoInvoices("stu-1", "Тест");
    expect(createYkPayment).not.toHaveBeenCalled();
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
