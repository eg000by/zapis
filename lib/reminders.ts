// Напоминание ученику о занятии — заранее и в человеческое время.
//
// Раньше это был один утренний крон в 09:00 МСК на всё подряд: занятие в 10:00
// предупреждалось за час (и будило человека), занятие в 20:00 — за одиннадцать
// (и забывалось). Теперь момент отправки зависит от времени самого занятия:
//
//   занятие начинается ДО 12:00 МСК  → накануне в 19:00 МСК
//   занятие начинается позже         → в тот же день в 10:00 МСК
//
// Считается не «во сколько запустился крон», а «когда нужно было отправить»:
// пульс дёргается часто, и напоминание уходит на первом же прогоне после нужного
// момента. Если прогонов не было дольше LATE_CUTOFF_HOURS — молчим совсем, чтобы
// опоздавший крон не написал человеку среди ночи.
import { listDayOccurrences, type DayOccurrence } from "./google";
import { getStudent } from "./students";
import { notifyStudent } from "./notify";
import { pingSent, recordPing } from "./pings";
import { MSK_OFFSET_MINUTES, MISSED_COLOR_ID } from "./config";

export const EVENING_HOUR_MSK = 19; // накануне — о завтрашних утренних занятиях
export const MORNING_HOUR_MSK = 10; // в день занятия — о дневных и вечерних
export const MORNING_LESSON_BEFORE_HOUR = 12; // «утреннее» занятие: начинается раньше этого часа
export const LATE_CUTOFF_HOURS = 3; // насколько поздно ещё допустимо отправить

// Час по МСК у момента времени.
export function mskHour(d: Date): number {
  return new Date(d.getTime() + MSK_OFFSET_MINUTES * 60000).getUTCHours();
}

// Момент (UTC) часа hour по МСК в календарных сутках МСК, отстоящих от d на dayOffset.
function mskHourOf(d: Date, hour: number, dayOffset: number): Date {
  const msk = new Date(d.getTime() + MSK_OFFSET_MINUTES * 60000);
  const dayStartUtc = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
  return new Date(
    dayStartUtc + dayOffset * 86400000 + hour * 3600000 - MSK_OFFSET_MINUTES * 60000
  );
}

// Когда следует напомнить о занятии, начинающемся в start.
export function reminderMomentFor(start: Date): Date {
  return mskHour(start) < MORNING_LESSON_BEFORE_HOUR
    ? mskHourOf(start, EVENING_HOUR_MSK, -1) // накануне вечером
    : mskHourOf(start, MORNING_HOUR_MSK, 0); // в тот же день утром
}

// «сегодня» / «завтра» — относительно момента отправки, а не занятия.
function dayWord(now: Date, start: Date): string {
  const dayOf = (d: Date) => {
    const msk = new Date(d.getTime() + MSK_OFFSET_MINUTES * 60000);
    return Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
  };
  const diff = (dayOf(start) - dayOf(now)) / 86400000;
  if (diff <= 0) return "сегодня";
  if (diff === 1) return "завтра";
  return "";
}

const hmMsk = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);

const dateMsk = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
  }).format(d);

export async function sendLessonReminders(now: Date): Promise<{ reminders: number }> {
  // Окно с запасом: вечером 19:00 нужны завтрашние утренние занятия (до ~17 часов
  // вперёд), утром 10:00 — сегодняшние вечерние (до ~14). Берём двое суток.
  const occ = await listDayOccurrences(now, new Date(now.getTime() + 2 * 86400000));

  // Занятия одного ученика с одним и тем же моментом отправки — одним сообщением
  // (два занятия подряд в один вечер не должны давать два уведомления).
  const groups = new Map<string, { studentId: string; at: Date; items: DayOccurrence[] }>();
  for (const o of occ) {
    if (!o.studentId) continue;
    if (o.colorId === MISSED_COLOR_ID) continue;
    if (o.start.getTime() <= now.getTime()) continue; // уже началось

    const at = reminderMomentFor(o.start);
    if (at.getTime() > now.getTime()) continue; // время напомнить ещё не пришло
    if (now.getTime() - at.getTime() > LATE_CUTOFF_HOURS * 3600000) continue; // проспали — молчим

    const key = `${o.studentId}:${at.toISOString()}`;
    const g = groups.get(key) || { studentId: o.studentId, at, items: [] };
    g.items.push(o);
    groups.set(key, g);
  }

  let reminders = 0;
  for (const [key, g] of groups) {
    try {
      if (await pingSent(`rem:${key}`)) continue;
      const s = await getStudent(g.studentId);
      if (!s?.tgChatId) continue;

      const times = g.items.map((o) => hmMsk(o.start)).join(", ");
      const first = g.items[0].start;
      const when = dayWord(now, first) || dateMsk(first);
      const word = g.items.length > 1 ? "занятия" : "занятие";
      await notifyStudent(s, `🔔 Напоминание: ${when} ${word} в <b>${times}</b> (МСК).`);
      await recordPing(`rem:${key}`);
      reminders++;
    } catch (e) {
      console.error("reminder failed", key, e);
    }
  }
  return { reminders };
}
