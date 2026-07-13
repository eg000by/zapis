// Сервисный слой «Занятия». Одна строка = одно занятие (блок/повтор — по факту
// проведения). Пишется из брони best-effort: если БД недоступна, запись в календарь
// всё равно проходит. Заметку по содержанию занятия добавляет преподаватель.
import { and, desc, eq, inArray } from "drizzle-orm";
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

export async function getLesson(id: string): Promise<Lesson | null> {
  const [row] = await db().select().from(lessons).where(eq(lessons.id, id)).limit(1);
  return row ?? null;
}

export async function getLessonsByEvent(calendarEventId: string): Promise<Lesson[]> {
  return db().select().from(lessons).where(eq(lessons.calendarEventId, calendarEventId));
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

// Строка занятия для КОНКРЕТНОГО повтора (заметка из утреннего отчёта). У серии в БД
// одна строка с временем первого занятия, поэтому для прошедшего повтора строки чаще
// нет — ищем по ученику и точному началу, при отсутствии создаём как проведённое.
export async function findOrCreateOccurrenceLesson(input: {
  studentId: string;
  calendarEventId: string;
  occurrenceStart: Date;
  subject?: string | null;
}): Promise<Lesson> {
  const [existing] = await db()
    .select()
    .from(lessons)
    .where(
      and(
        eq(lessons.studentId, input.studentId),
        eq(lessons.occurrenceStart, input.occurrenceStart)
      )
    )
    .limit(1);
  if (existing) return existing;
  return recordLesson({ ...input, status: "done" });
}

// Синхронизация статуса занятия с решением по заявке в календаре
// (подтверждение/отклонение из Telegram, отмена). По calendar_event_id.
export async function setLessonStatusByEvent(
  calendarEventId: string,
  status: string
): Promise<void> {
  await db().update(lessons).set({ status }).where(eq(lessons.calendarEventId, calendarEventId));
}

// Обновление занятия по calendar_event_id (перенос: новое время + снова pending).
export async function updateLessonByEvent(
  calendarEventId: string,
  fields: Partial<{ status: string; occurrenceStart: Date | null }>
): Promise<void> {
  await db().update(lessons).set(fields).where(eq(lessons.calendarEventId, calendarEventId));
}

// Помечает отменёнными занятия по списку id (сверка с календарём — источником правды).
export async function markLessonsCancelled(ids: string[]): Promise<void> {
  const clean = ids.filter(Boolean);
  if (!clean.length) return;
  await db().update(lessons).set({ status: "cancelled" }).where(inArray(lessons.id, clean));
}
