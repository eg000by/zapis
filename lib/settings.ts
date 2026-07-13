// Настройки сервиса (ключ-значение в Postgres). Сейчас — способ оплаты:
// «ЮKassa» (кнопка со ссылкой, комиссия провайдера) или «СБП-перевод» (в кабинете
// показываются реквизиты, оплату преподаватель отмечает вручную).
import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings } from "./schema";

export type PayMethod = "yookassa" | "sbp";

// Реквизиты по умолчанию — текст можно поменять в /admin.
export const DEFAULT_SBP_DETAILS = "Перевод по СБП на номер 8 927 750-23-78 (Т-Банк или Сбер)";

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db().select().from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db()
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function getPayMethod(): Promise<PayMethod> {
  return (await getSetting("payMethod")) === "sbp" ? "sbp" : "yookassa";
}

export async function getSbpDetails(): Promise<string> {
  return (await getSetting("sbpDetails")) || DEFAULT_SBP_DETAILS;
}
