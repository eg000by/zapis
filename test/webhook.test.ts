import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/payments/webhook/route";
import { getYkPayment, yookassaConfigured } from "@/lib/yookassa";
import {
  getPayment,
  getPaymentByProviderId,
  setPaymentStatus,
  updatePayment,
} from "@/lib/payments";
import { recolorStudent } from "@/lib/coloring";
import { sendOwner } from "@/lib/telegram";

vi.mock("@/lib/yookassa", () => ({
  yookassaConfigured: vi.fn(() => true),
  getYkPayment: vi.fn(),
}));
vi.mock("@/lib/payments", () => ({
  getPayment: vi.fn(async () => null),
  getPaymentByProviderId: vi.fn(async () => null),
  setPaymentStatus: vi.fn(async () => {}),
  updatePayment: vi.fn(async () => {}),
}));
vi.mock("@/lib/students", () => ({
  getStudent: vi.fn(async () => ({ id: "stu-1", name: "Тест Тестов" })),
}));
vi.mock("@/lib/coloring", () => ({ recolorStudent: vi.fn(async () => {}) }));
vi.mock("@/lib/telegram", () => ({
  sendOwner: vi.fn(async () => {}),
  escapeHtml: (s: string) => s,
}));

function call(body: unknown) {
  return POST(
    new Request("http://test/api/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

const EVENT = { type: "notification", event: "payment.succeeded", object: { id: "yk-1" } };

const OUR = {
  id: "p1",
  studentId: "stu-1",
  amountKopecks: 300000,
  status: "unpaid",
  note: "Автосчёт: долг",
  providerPaymentId: "yk-1",
};

function ykPayment(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "yk-1",
    status: "succeeded",
    confirmationUrl: "",
    metadata: { paymentId: "p1" },
    amountKopecks: 300000,
    ...over,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(yookassaConfigured).mockReturnValue(true);
  vi.mocked(getPayment).mockResolvedValue(null);
  vi.mocked(getPaymentByProviderId).mockResolvedValue(null);
});

describe("/api/payments/webhook — ЮKassa", () => {
  it("успешная оплата: статус из API (не из тела), счёт оплачен, перекраска, уведомление", async () => {
    vi.mocked(getYkPayment).mockResolvedValue(ykPayment());
    vi.mocked(getPayment).mockResolvedValue(OUR as any);

    const res = await call(EVENT);
    expect(res.status).toBe(200);
    expect(getYkPayment).toHaveBeenCalledWith("yk-1"); // перечитали из API
    expect(setPaymentStatus).toHaveBeenCalledWith("p1", "paid");
    expect(recolorStudent).toHaveBeenCalledWith("stu-1");
    expect(vi.mocked(sendOwner).mock.calls[0][0]).toContain("Оплата получена");
  });

  it("телу уведомления не верим: если API говорит pending — ничего не меняем", async () => {
    vi.mocked(getYkPayment).mockResolvedValue(ykPayment({ status: "pending" }));
    vi.mocked(getPayment).mockResolvedValue(OUR as any);

    await call(EVENT); // тело кричит «succeeded», API — pending
    expect(setPaymentStatus).not.toHaveBeenCalled();
  });

  it("повтор уведомления об оплаченном счёте — идемпотентно", async () => {
    vi.mocked(getYkPayment).mockResolvedValue(ykPayment());
    vi.mocked(getPayment).mockResolvedValue({ ...OUR, status: "paid" } as any);

    await call(EVENT);
    expect(setPaymentStatus).not.toHaveBeenCalled();
    expect(sendOwner).not.toHaveBeenCalled();
  });

  it("сумма платежа не сошлась со счётом — не засчитываем, предупреждаем владельца", async () => {
    vi.mocked(getYkPayment).mockResolvedValue(ykPayment({ amountKopecks: 100000 }));
    vi.mocked(getPayment).mockResolvedValue(OUR as any);

    await call(EVENT);
    expect(setPaymentStatus).not.toHaveBeenCalled();
    expect(vi.mocked(sendOwner).mock.calls[0][0]).toContain("не сошлась");
  });

  it("платёж отменён/истёк — чистим ссылку, чтобы кабинет сгенерировал новую", async () => {
    vi.mocked(getYkPayment).mockResolvedValue(ykPayment({ status: "canceled" }));
    vi.mocked(getPayment).mockResolvedValue(OUR as any);

    await call({ ...EVENT, event: "payment.canceled" });
    expect(updatePayment).toHaveBeenCalledWith("p1", { payLink: "", providerPaymentId: "" });
    expect(setPaymentStatus).not.toHaveBeenCalled();
  });

  it("чужой платёж (нет нашего счёта) — 200 и тишина", async () => {
    vi.mocked(getYkPayment).mockResolvedValue(ykPayment({ metadata: {} }));
    const res = await call(EVENT);
    expect(res.status).toBe(200);
    expect(setPaymentStatus).not.toHaveBeenCalled();
  });

  it("счёт находится и по providerPaymentId (если metadata потерялась)", async () => {
    vi.mocked(getYkPayment).mockResolvedValue(ykPayment({ metadata: {} }));
    vi.mocked(getPaymentByProviderId).mockResolvedValue(OUR as any);
    await call(EVENT);
    expect(setPaymentStatus).toHaveBeenCalledWith("p1", "paid");
  });

  it("ЮKassa API недоступен — 500, чтобы уведомление повторили", async () => {
    vi.mocked(getYkPayment).mockRejectedValue(new Error("timeout"));
    expect((await call(EVENT)).status).toBe(500);
  });

  it("ЮKassa не настроена или тело без id — 200 без действий", async () => {
    vi.mocked(yookassaConfigured).mockReturnValue(false);
    expect((await call(EVENT)).status).toBe(200);
    vi.mocked(yookassaConfigured).mockReturnValue(true);
    expect((await call({})).status).toBe(200);
    expect(getYkPayment).not.toHaveBeenCalled();
  });
});
