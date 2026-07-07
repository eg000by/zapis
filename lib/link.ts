// Персональная ссылка: имя получателя и его telegram зашиты в токен и подписаны
// HMAC, чтобы значения нельзя было подделать вручную. В токен также кладём время
// выпуска (iat) — по нему ссылка протухает через LINK_TTL_HOURS. Ссылку открывает
// тот, кому вы её отправили (сам ученик или его близкие) — нейтрально к роли.
import crypto from "crypto";
import { LINK_TTL_HOURS } from "./config";

export interface Contact {
  name: string; // отображаемое имя, напр. "Егор" или "Мама Егора"
  tg: string; // telegram, напр. "@egor" (может быть пустым)
}

// Результат разбора токена: либо данные, либо причина отказа.
export type DecodeResult =
  | { ok: true; info: Contact }
  | { ok: false; reason: "invalid" | "expired" };

function secret(): string {
  const s = process.env.LINK_SIGNING_SECRET;
  if (!s) throw new Error("LINK_SIGNING_SECRET is not set");
  return s;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
  return b64urlEncode(crypto.createHmac("sha256", secret()).update(payload).digest()).slice(0, 22);
}

export function encodeToken(info: Contact): string {
  const payload = b64urlEncode(
    Buffer.from(JSON.stringify({ n: info.name, tg: info.tg, iat: Date.now() }), "utf8")
  );
  return `${payload}.${sign(payload)}`;
}

export function decodeToken(token: string | undefined | null): DecodeResult {
  if (!token) return { ok: false, reason: "invalid" };
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return { ok: false, reason: "invalid" };
  const expected = sign(payload);
  // Сравнение постоянного времени
  if (sig.length !== expected.length) return { ok: false, reason: "invalid" };
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const obj = JSON.parse(b64urlDecode(payload).toString("utf8"));
    if (typeof obj.n !== "string") return { ok: false, reason: "invalid" };
    if (LINK_TTL_HOURS > 0) {
      const iat = typeof obj.iat === "number" ? obj.iat : 0;
      // Токены без метки времени (старый формат) считаем протухшими.
      if (!iat || Date.now() - iat > LINK_TTL_HOURS * 3600 * 1000) {
        return { ok: false, reason: "expired" };
      }
    }
    return { ok: true, info: { name: obj.n, tg: typeof obj.tg === "string" ? obj.tg : "" } };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

// Стабильный ключ владельца ссылки — кладём в событие, чтобы потом показать
// именно его записи и разрешить переносить/отменять только их.
export function contactKey(info: Contact): string {
  const h = crypto.createHmac("sha256", secret()).update(`k:${info.name}\n${info.tg}`).digest();
  return b64urlEncode(h).slice(0, 16);
}
