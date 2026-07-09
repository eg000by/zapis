// Короткие ссылки записи: прячем длинный подписанный токен за коротким кодом в URL
// (/z/<code>), чтобы ссылка выглядела дружелюбно. Код стабилен для пары (ученик, trial),
// поэтому повторное открытие карточки не плодит новые коды. Токен внутри — тот же, что и
// в /?t=, со всей его подписью; сам токен ученику больше не показываем.
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { bookingLinks, students } from "./schema";
import { encodeToken } from "./link";

// Алфавит без похожих символов (0/O, 1/l/I) — код удобно продиктовать.
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function randomCode(len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

// Возвращает подписанный токен по короткому коду (или null, если код неизвестен).
export async function getTokenByCode(code: string): Promise<string | null> {
  const [row] = await db()
    .select({ token: bookingLinks.token })
    .from(bookingLinks)
    .where(eq(bookingLinks.code, code))
    .limit(1);
  return row?.token ?? null;
}

// Стабильный короткий код персональной ссылки ученика (создаётся при первом обращении).
// trial=true — отдельная ссылка на разовое пробное занятие.
export async function getOrCreateStudentLinkCode(
  studentId: string,
  trial = false
): Promise<string> {
  const existing = await db()
    .select({ code: bookingLinks.code })
    .from(bookingLinks)
    .where(and(eq(bookingLinks.studentId, studentId), eq(bookingLinks.trial, trial)))
    .limit(1);
  if (existing[0]) return existing[0].code;

  const [s] = await db().select().from(students).where(eq(students.id, studentId)).limit(1);
  if (!s) throw new Error("student not found for link");
  const token = encodeToken({
    name: s.name,
    subject: s.subject,
    tg: s.tg,
    trial,
    studentId: s.id,
  });

  // Уникальный код: несколько попыток на случай коллизии по первичному ключу.
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode(6);
    try {
      await db().insert(bookingLinks).values({ code, token, studentId: s.id, trial });
      return code;
    } catch (e) {
      if (attempt === 5) throw e;
    }
  }
  throw new Error("could not allocate link code");
}
