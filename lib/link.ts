// Персональная ссылка родителя: имя + telegram зашиты в токен и подписаны HMAC,
// чтобы значения нельзя было подделать вручную.
import crypto from "crypto";

export interface ParentInfo {
  name: string; // отображаемое имя, напр. "Мама Марина"
  tg: string; // telegram, напр. "@marina" (может быть пустым)
}

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

export function encodeParentToken(info: ParentInfo): string {
  const payload = b64urlEncode(Buffer.from(JSON.stringify({ n: info.name, tg: info.tg }), "utf8"));
  return `${payload}.${sign(payload)}`;
}

export function decodeParentToken(token: string | undefined | null): ParentInfo | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  // Сравнение постоянного времени
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const obj = JSON.parse(b64urlDecode(payload).toString("utf8"));
    if (typeof obj.n !== "string") return null;
    return { name: obj.n, tg: typeof obj.tg === "string" ? obj.tg : "" };
  } catch {
    return null;
  }
}
