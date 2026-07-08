// Сервисный слой «Ученики». Общая логика для сайта (/admin) и Telegram-бота —
// обе поверхности дергают эти функции, а не пишут в БД напрямую (паритет админки).
// Календарь остаётся источником правды для расписания; здесь — учётные данные ученика.
import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { students, type Student } from "./schema";

// Заводит или обновляет ученика по contactKey (HMAC имени+предмета+tg, lib/link.ts).
// contactKey стабилен для связки имя/предмет/tg, поэтому повторная бронь того же
// ученика не плодит дубликаты, а освежает поля.
export async function upsertStudent(input: {
  name: string;
  subject: string;
  tg: string;
  contactKey: string;
}): Promise<Student> {
  const [row] = await db()
    .insert(students)
    .values(input)
    .onConflictDoUpdate({
      target: students.contactKey,
      set: { name: input.name, subject: input.subject, tg: input.tg },
    })
    .returning();
  return row;
}

export async function listStudents(): Promise<Student[]> {
  return db().select().from(students).orderBy(desc(students.createdAt));
}

export async function getStudent(id: string): Promise<Student | null> {
  const [row] = await db().select().from(students).where(eq(students.id, id)).limit(1);
  return row ?? null;
}

export async function getStudentByContactKey(key: string): Promise<Student | null> {
  const [row] = await db().select().from(students).where(eq(students.contactKey, key)).limit(1);
  return row ?? null;
}

export async function updateStudent(
  id: string,
  fields: Partial<Pick<Student, "name" | "tg" | "subject" | "rateKopecks" | "active" | "note">>
): Promise<void> {
  await db().update(students).set(fields).where(eq(students.id, id));
}
