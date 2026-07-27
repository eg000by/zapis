// Продление занятий: серия в календаре конечна (RRULE:FREQ=WEEKLY;COUNT=26 ≈ полгода),
// и без напоминания она просто молча заканчивается — ученик уходит не потому, что решил
// уйти, а потому, что в календаре кончились повторы. За RENEW_NOTICE_DAYS до последнего
// занятия владелец получает в бот вопрос «продлить?» с кнопкой.
//
// Дедупликация — та же таблица lesson_pings (ключ включает дату последнего занятия,
// поэтому после продления следующее напоминание придёт уже про новый конец серии).
import { lastOccurrenceOf, listSeriesMasters } from "./google";
import { pingSent, recordPing } from "./pings";
import { escapeHtml, inlineKeyboard, sendOwner } from "./telegram";

// За сколько дней до конца серии спрашивать о продлении.
export const RENEW_NOTICE_DAYS = 21;

export interface EndingSeries {
  eventId: string;
  student: string;
  subject: string;
  lastStart: Date;
  slot: string; // «по вторникам в 10:00»
}

const fmtSlot = (d: Date) => {
  const wd = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "long",
  }).format(d);
  const hm = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  return `${wd} в ${hm}`;
};

export const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
  }).format(d);

// Серии, у которых последнее занятие ближе, чем через withinDays дней. Бесконечные
// правила (без COUNT/UNTIL) пропускаем — им нечего продлевать. Серии, у которых
// будущих занятий уже не осталось, тоже пропускаем: напоминать поздно, а спам по
// давно закончившимся сериям пришёл бы каждый день.
export async function findEndingSeries(
  now: Date,
  withinDays = RENEW_NOTICE_DAYS
): Promise<EndingSeries[]> {
  const masters = await listSeriesMasters();
  const horizon = now.getTime() + withinDays * 86400000;
  const out: EndingSeries[] = [];
  for (const m of masters) {
    if (!m.finite) continue;
    try {
      const last = await lastOccurrenceOf(m.id, now);
      if (!last) continue;
      const lastStart = new Date(last);
      if (lastStart.getTime() > horizon) continue;
      out.push({
        eventId: m.id,
        student: m.student,
        subject: m.subject,
        lastStart,
        slot: fmtSlot(m.start),
      });
    } catch (e) {
      console.error("findEndingSeries: instances failed", m.id, e);
    }
  }
  return out;
}

// Шлёт владельцу вопрос о продлении по каждой заканчивающейся серии (один раз на
// «серия + дата конца»). Возвращает число отправленных сообщений.
export async function sendRenewalPrompts(
  now: Date,
  withinDays = RENEW_NOTICE_DAYS
): Promise<{ asked: number }> {
  let asked = 0;
  for (const s of await findEndingSeries(now, withinDays)) {
    const key = `renew:${s.eventId}:${s.lastStart.toISOString().slice(0, 10)}`;
    try {
      if (await pingSent(key)) continue;
      const days = Math.max(0, Math.round((s.lastStart.getTime() - now.getTime()) / 86400000));
      await sendOwner(
        `🔁 <b>Занятия скоро закончатся</b>\n\n` +
          `🧑‍🎓 ${escapeHtml(s.student || "?")} · ${escapeHtml(s.subject)}\n` +
          `🕒 ${escapeHtml(s.slot)}\n` +
          `📅 Последнее занятие — ${fmtDate(s.lastStart)} (через ${days} дн.)\n\n` +
          `Продлить серию ещё на полгода?`,
        inlineKeyboard([
          [
            { text: "🔁 Продлить", data: `renew:${s.eventId}` },
            { text: "👌 Не сейчас", data: "renewno" },
          ],
        ])
      );
      await recordPing(key);
      asked++;
    } catch (e) {
      console.error("sendRenewalPrompts failed", s.eventId, e);
    }
  }
  return { asked };
}
