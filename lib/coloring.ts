// Цветовая пометка занятий в Google Calendar по статусу оплаты (Фаза 3).
// Календарь — источник правды расписания; цвет — производная от учёта в БД.
// Правило: оплачено → зелёный; подтверждено, но не оплачено → красный;
// ждёт подтверждения (pending) → не трогаем (цвет календаря по умолчанию).
import { setEventColor } from "./google";
import { getLesson, getLessonsByEvent } from "./lessons";
import { isLessonPaid, lessonIdsForPayment } from "./payments";
import type { Lesson } from "./schema";

// colorId Google Calendar: 10 = Basil (зелёный), 11 = Tomato (красный).
export const EVENT_COLOR = { paid: "10", unpaid: "11" } as const;

async function colorFor(lesson: Lesson): Promise<string | null> {
  if (!lesson.calendarEventId) return null;
  if (await isLessonPaid(lesson.id)) return EVENT_COLOR.paid;
  if (lesson.status === "confirmed") return EVENT_COLOR.unpaid;
  return null; // pending — оставляем цвет по умолчанию
}

async function apply(lesson: Lesson): Promise<void> {
  const color = await colorFor(lesson);
  if (color && lesson.calendarEventId) await setEventColor(lesson.calendarEventId, color);
}

export async function recolorLesson(lessonId: string): Promise<void> {
  const lesson = await getLesson(lessonId);
  if (lesson) await apply(lesson);
}

// Перекрашивает событие занятия (триггер — подтверждение заявки из Telegram).
export async function recolorEvent(eventId: string): Promise<void> {
  for (const l of await getLessonsByEvent(eventId)) await apply(l);
}

// Перекрашивает все занятия, покрытые платежом (триггер — отметка оплаты).
export async function recolorPaymentLessons(paymentId: string): Promise<void> {
  for (const id of await lessonIdsForPayment(paymentId)) await recolorLesson(id);
}
