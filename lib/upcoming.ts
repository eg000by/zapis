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
import { activeMembers, getGroup } from "./groups";
import type { Student } from "./schema";
import { listStudentLessons } from "./lessons";
import { pingSent, recordPing } from "./pings";
import { notifyStudent } from "./notify";
import { escapeHtml, sendOwner } from "./telegram";
import { formatMskRange } from "./slots";
import { MISSED_COLOR_ID, teacherTgUrl } from "./config";

// За сколько до начала предупреждать — это ОКНО, а не точный момент: занятие
// попадает в уведомление на первом прогоне пульса внутри окна.
//
// Час работает, пока пульс дёргается часто. Основной планировщик — внешний пингер
// (cron-job.org, каждые 5 минут), workflow в GitHub Actions остался подстраховкой.
// Пока пингера не было, окна в час не хватало: GitHub душит кроны публичных
// репозиториев, промежутки между прогонами доходили до 3 часов, и занятие, чьё окно
// целиком попало в простой, оставалось без уведомления вовсе (30 июля, занятие в
// 10:10). Тогда окно временно расширяли до 180 минут — с пингером это не нужно и
// даже вредно: уведомление приходило бы за три часа вместо часа.
//
// Если пингер отвалится, а GitHub снова начнёт просыпать — уведомления будут
// теряться молча. Сторож («пульс не отвечал N часов») пока не сделан.
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
      if (!o.studentId && !o.groupId) continue;
      if (o.colorId === MISSED_COLOR_ID) continue; // помечено пропуском заранее
      const key = `soon:${o.instanceId}`;
      if (await pingSent(key)) continue;

      // Групповое занятие касается всех участников: преподавателю пишем один раз,
      // ученикам — каждому. Ссылка на занятие у группы своя, общая.
      const group = o.groupId ? await getGroup(o.groupId).catch(() => null) : null;
      const student = group ? null : await getStudent(o.studentId).catch(() => null);
      const members: Student[] = group
        ? await activeMembers(group.id).catch(() => [])
        : student
          ? [student]
          : [];
      const meet = group ? group.meetLink : student?.meetLink || "";

      // Сколько осталось — НЕ пишем: прогон крона может опоздать или прийти раньше,
      // и «через 45 минут» окажется враньём. Время начала верно всегда.
      const meetLine = meet
        ? `🎥 Телемост: ${meet}`
        : "⚠️ Ссылка на Телемост не задана — добавьте в карточке ученика.";
      await sendOwner(
        `⏰ <b>Скоро занятие</b>\n\n` +
          `🧑‍🎓 ${escapeHtml(o.student || "?")} · ${escapeHtml(o.subject)}\n` +
          `🕒 ${escapeHtml(formatMskRange(o.start.toISOString(), o.hours))}\n` +
          `${meetLine}\n\n` +
          `${o.groupId ? `👥 Участников: ${members.length}` : await previousLessonLine(o.studentId, now)}`
      );

      // Ученикам — то же напоминание и та же ссылка (кому подключены уведомления).
      const contact = teacherTgUrl();
      for (const m of members) {
        if (!m.tgChatId) continue;
        await notifyStudent(
          m,
          `⏰ <b>Скоро занятие</b>\n\n` +
            `Начало в ${hmMsk(o.start)} (МСК).\n` +
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
