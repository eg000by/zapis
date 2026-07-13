// Утренний крон (09:00 МСК, vercel.json → /api/cron/morning): напоминания ученикам
// с подключёнными уведомлениями «сегодня занятие в …». Опрос «как прошло занятие?»
// уехал в pulse-крон (lib/pulse.ts) — сразу после конца занятия; решение по пробным
// теперь принимает владелец вручную (кнопка «Сделать полноценным» в боте/админке).
import { listDayOccurrences, type DayOccurrence } from "./google";
import { getStudent } from "./students";
import { notifyStudent } from "./notify";
import { MSK_OFFSET_MINUTES } from "./config";

// Начало суток МСК (в UTC-моменте) для дня, отстоящего на offsetDays от сегодняшнего.
export function mskDayStart(now: Date, offsetDays = 0): Date {
  const msk = new Date(now.getTime() + MSK_OFFSET_MINUTES * 60000);
  const dayUtcMs = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
  return new Date(dayUtcMs - MSK_OFFSET_MINUTES * 60000 + offsetDays * 86400000);
}

const hmMsk = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);

// Напоминания ученикам: у кого сегодня занятие и подключены уведомления —
// «сегодня занятие в …». Возвращает число отправленных напоминаний.
export async function sendTodayReminders(now: Date): Promise<{ reminders: number }> {
  const from = mskDayStart(now, 0);
  const to = mskDayStart(now, 1);
  const occ = await listDayOccurrences(from, to);

  // Группируем по ученику: у блока/нескольких занятий в день — одно сообщение.
  const byStudent = new Map<string, DayOccurrence[]>();
  for (const o of occ) {
    if (!o.studentId) continue;
    const list = byStudent.get(o.studentId) || [];
    list.push(o);
    byStudent.set(o.studentId, list);
  }

  let reminders = 0;
  for (const [studentId, list] of byStudent) {
    try {
      const s = await getStudent(studentId);
      if (!s?.tgChatId) continue;
      const times = list.map((o) => hmMsk(o.start)).join(", ");
      await notifyStudent(
        s,
        `🔔 Напоминание: сегодня ${list.length > 1 ? "занятия" : "занятие"} в <b>${times}</b> (МСК).`
      );
      reminders++;
    } catch (e) {
      console.error("morning/reminder failed", studentId, e);
    }
  }
  return { reminders };
}
