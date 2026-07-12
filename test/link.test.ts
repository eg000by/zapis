import { describe, expect, it } from "vitest";
import { contactKey, decodeToken, encodeToken } from "@/lib/link";

const INFO = { name: "Тест Тестов", subject: "Математика", tg: "@test", trial: false };

describe("encodeToken / decodeToken", () => {
  it("токен восстанавливается в исходные данные", () => {
    const d = decodeToken(encodeToken(INFO));
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.info).toMatchObject({
        name: "Тест Тестов",
        subject: "Математика",
        tg: "@test",
        trial: false,
      });
    }
  });

  it("переносит trial и studentId", () => {
    const d = decodeToken(encodeToken({ ...INFO, trial: true, studentId: "abc-123" }));
    expect(d.ok && d.info.trial).toBe(true);
    expect(d.ok && d.info.studentId).toBe("abc-123");
  });

  it("подделанная подпись — invalid", () => {
    const t = encodeToken(INFO);
    const [payload] = t.split(".");
    expect(decodeToken(`${payload}.AAAAAAAAAAAAAAAAAAAAAA`)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("изменённый payload не проходит подпись", () => {
    const t = encodeToken(INFO);
    const [, sig] = t.split(".");
    const other = encodeToken({ ...INFO, name: "Другой" }).split(".")[0];
    expect(decodeToken(`${other}.${sig}`).ok).toBe(false);
  });

  it("пустой / битый токен — invalid", () => {
    expect(decodeToken(undefined).ok).toBe(false);
    expect(decodeToken("").ok).toBe(false);
    expect(decodeToken("одна-часть").ok).toBe(false);
  });
});

describe("contactKey", () => {
  it("детерминирован и не зависит от trial/studentId", () => {
    const a = contactKey(INFO);
    const b = contactKey({ ...INFO, trial: true, studentId: "x" });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("меняется при смене имени/предмета/tg", () => {
    expect(contactKey({ ...INFO, name: "Другой" })).not.toBe(contactKey(INFO));
    expect(contactKey({ ...INFO, subject: "Питон" })).not.toBe(contactKey(INFO));
    expect(contactKey({ ...INFO, tg: "" })).not.toBe(contactKey(INFO));
  });
});
