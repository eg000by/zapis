// Клиент ЮKassa (https://yookassa.ru/developers/api) — генерация ссылок на оплату
// и сверка статуса платежа. Ключи в env: YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY.
// Без ключей модуль «выключен» (yookassaConfigured() = false) — счета живут без
// ссылок, как раньше, и сайт продолжает работать.
import { siteBaseUrl } from "./config";

const API = "https://api.yookassa.ru/v3";

export function yookassaConfigured(): boolean {
  return !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
}

function authHeader(): string {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secret) throw new Error("YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не заданы");
  return "Basic " + Buffer.from(`${shopId}:${secret}`).toString("base64");
}

export interface YkPayment {
  id: string;
  status: string; // pending | waiting_for_capture | succeeded | canceled
  confirmationUrl: string;
  metadata: Record<string, string>;
  amountKopecks: number;
}

function parseYk(data: any): YkPayment {
  return {
    id: String(data?.id || ""),
    status: String(data?.status || ""),
    confirmationUrl: String(data?.confirmation?.confirmation_url || ""),
    metadata: (data?.metadata as Record<string, string>) || {},
    amountKopecks: Math.round(Number(data?.amount?.value || 0) * 100),
  };
}

// Создаёт платёж в ЮKassa под наш счёт (payments.id кладём в metadata для вебхука).
// Idempotence-Key включает сумму: повтор с той же суммой не создаст дубль, смена
// суммы счёта создаст новый платёж (старая ссылка перестаёт быть актуальной у нас).
export async function createYkPayment(input: {
  ourPaymentId: string;
  amountKopecks: number;
  description: string;
}): Promise<YkPayment> {
  const res = await fetch(`${API}/payments`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      "Idempotence-Key": `${input.ourPaymentId}:${input.amountKopecks}`,
    },
    body: JSON.stringify({
      amount: { value: (input.amountKopecks / 100).toFixed(2), currency: "RUB" },
      capture: true,
      confirmation: { type: "redirect", return_url: siteBaseUrl() || "https://zapis-ten.vercel.app" },
      description: input.description.slice(0, 128),
      metadata: { paymentId: input.ourPaymentId },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ЮKassa create payment: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return parseYk(await res.json());
}

// Статус платежа из API — единственный доверенный источник для вебхука
// (телу уведомления не верим: его может прислать кто угодно).
export async function getYkPayment(id: string): Promise<YkPayment> {
  const res = await fetch(`${API}/payments/${encodeURIComponent(id)}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`ЮKassa get payment: HTTP ${res.status}`);
  return parseYk(await res.json());
}
