// Сервисный слой «Занятия». Одна строка = одно занятие (блок/повтор — по факту
// проведения). Пишется из брони best-effort: если БД недоступна, запись в календарь
// всё равно проходит. Заметку по содержанию занятия добавляет преподаватель.
import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { lessons, type Lesson } from "./schema";

export async function recordLesson(input: {
  studentId: string;
  calendarEventId?: string | null;
  occurrenceStart?: Date | null;
  subject?: string | null;
  status?: string;
}): Promise<Lesson> {
  const [row] = await db()
    .insert(lessons)
    .values({
      studentId: input.studentId,
      calendarEventId: input.calendarEventId ?? null,
      occurrenceStart: input.occurrenceStart ?? null,
      subject: input.subject ?? null,
      status: input.status ?? "pending",
    })
    .returning();
  return row;
}

export async function listStudentLessons(studentId: string, limit = 30): Promise<Lesson[]> {
  return db()
    .select()
    .from(lessons)
    .where(eq(lessons.studentId, studentId))
    .orderBy(desc(lessons.occurrenceStart))
    .limit(limit);
}

export async function setLessonNote(id: string, note: string): Promise<void> {
  await db().update(lessons).set({ note }).where(eq(lessons.id, id));
}

// Синхронизация статуса занятия с решением по заявке в календаре
// (подтверждение/отклонение из Telegram). По calendar_event_id.
export async function setLessonStatusByEvent(
  calendarEventId: string,
  status: string
): Promise<void> {
  await db().update(lessons).set({ status }).where(eq(lessons.calendarEventId, calendarEventId));
}
