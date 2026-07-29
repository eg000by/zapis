// Уведомление «скоро занятие» — преподавателю всегда, ученику при подключённых
// уведомлениях, одним и тем же прогоном (чтобы обе стороны узнавали одновременно).
//
// Дёргается из pulse-крона (каждые ~5 минут внутри прогона), поэтому работает по окну,
// а не по точному моменту: занятие попадает в уведомление, если начинается в ближайшие
// UPCOMING_LEAD_MINUTES и по нему ещё не писали. Дедупликация — та же таблица
// lesson_pings с префиксом soon: (вопрос «как прошло» пишется по чистому instanceId,
// так что ключи не сталкиваются). Пропущенный прогон не рассылает задним числом:
// уже начавшееся занятие в окно не входит.
import { listDayOccurrences } from "./google";
import { getStudent } from "./students";
import { listStudentLessons } from "./lessons";
import { pingSent, recordPing } from "./pings";
import { notifyStudent } from "./notify";
import { escapeHtml, sendOwner } from "./telegram";
import { formatMskRange } from "./slots";
import { MISSED_COLOR_ID, teacherTgUrl } from "./config";

// За сколько до начала предупреждать. Одно число — менять здесь.
export const UPCOMING_LEAD_MINUTES = 60;
// Сколько символов заметки прошлого занятия показывать.
const NOTE_PREVIEW = 200;

const hmMsk = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);

const dayMsk = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
  }).format(d);

// Чем закончилось прошлое занятие: дата и заметка преподавателя. Строки занятий
// заводятся, когда к занятию пишут заметку («Прошло» / 📝), поэтому именно они и
// есть «информация о прошлом занятии».
export async function previousLessonLine(studentId: string, now: Date): Promise<string> {
  try {
    const rows = await listStudentLessons(studentId, 20);
    const past = rows.filter(
      (l) => l.occurrenceStart && new Date(l.occurrenceStart).getTime() < now.getTime()
    );
    const last = past[0]; // отсортированы по occurrenceStart убыв.
    if (!last) return "📝 Прошлое занятие: это первое.";
    const when = dayMsk(new Date(last.occurrenceStart as unknown as string));
    if (!last.note) return `📝 Прошлое занятие (${when}): заметки нет.`;
    const note =
      last.note.length > NOTE_PREVIEW ? `${last.note.slice(0, NOTE_PREVIEW).trimEnd()}…` : last.note;
    return `📝 Прошлое занятие (${when}): ${escapeHtml(note)}`;
  } catch (e) {
    console.error("previousLessonLine failed", studentId, e);
    return "";
  }
}

export async function sendUpcomingLessonAlerts(now: Date): Promise<{ sent: number }> {
  const until = new Date(now.getTime() + UPCOMING_LEAD_MINUTES * 60000);
  // Google отдаёт всё, что ПЕРЕСЕКАЕТ окно, — уже идущее занятие отсекаем сами.
  const occ = (await listDayOccurrences(now, until)).filter(
    (o) => o.start.getTime() >= now.getTime()
  );

  let sent = 0;
  for (const o of occ) {
    try {
      if (!o.studentId) continue;
      if (o.colorId === MISSED_COLOR_ID) continue; // помечено пропуском заранее
      const key = `soon:${o.instanceId}`;
      if (await pingSent(key)) continue;

      const student = await getStudent(o.studentId).catch(() => null);
      const minutes = Math.max(1, Math.round((o.start.getTime() - now.getTime()) / 60000));
      const meet = student?.meetLink || "";

      // Преподавателю: с чем идём на занятие — ссылка и чем кончилось прошлое.
      const meetLine = meet
        ? `🎥 Телемост: ${meet}`
        : "⚠️ Ссылка на Телемост не задана — добавьте в карточке ученика.";
      await sendOwner(
        `⏰ <b>Через ${minutes} мин занятие</b>\n\n` +
          `🧑‍🎓 ${escapeHtml(o.student || "?")} · ${escapeHtml(o.subject)}\n` +
          `🕒 ${escapeHtml(formatMskRange(o.start.toISOString(), o.hours))}\n` +
          `${meetLine}\n\n` +
          `${await previousLessonLine(o.studentId, now)}`
      );

      // Ученику — то же напоминание и та же ссылка (если подключил уведомления).
      if (student?.tgChatId) {
        const contact = teacherTgUrl();
        await notifyStudent(
          student,
          `⏰ <b>Скоро занятие</b>\n\n` +
            `Через ${minutes} мин — в ${hmMsk(o.start)} (МСК).\n` +
            (meet ? `🎥 Подключиться: ${meet}\n` : "") +
            (contact ? `\nВопрос преподавателю: ${contact}` : "")
        );
      }

      await recordPing(key);
      sent++;
    } catch (e) {
      console.error("upcoming: occurrence failed", o.instanceId, e);
    }
  }
  return { sent };
}
