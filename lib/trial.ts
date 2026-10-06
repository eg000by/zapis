// Быстрая запись пробного занятия самим преподавателем (через бота).
//
// Обычный путь — мастер «Новый ученик» (имя → предмет → Telegram → ставка → тип) и
// ссылка, по которой ученик записывается сам, — для пробных слишком длинный:
// родитель называет время в переписке, и проще поставить занятие сразу. Здесь —
// логика без Telegram: окна недели, текст для родителя, разбор строки «Маша ОГЭ»,
// сама запись и её отмена. Экраны бота — в lib/trial-bot.ts.
import {
  CALENDAR_ID,
  calendarClient,
  fetchBusy,
  lessonDescription,
  liveEventIdsForContact,
  type BusyEvent,
} from "./google";
import { buildWeek, validateSlot, weekWindowBounds } from "./slots";
import { MSK_OFFSET_MINUTES, TIMEZONE } from "./config";
import { contactKey } from "./link";
import { deleteStudent, getStudent, upsertStudent } from "./students";
import { recordLesson, setLessonStatusByEvent } from "./lessons";

const WEEK_MS = 7 * 86400000;
const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export interface TrialSlot {
  start: string; // ISO
  time: string; // «15:00» (МСК)
  near: boolean; // рекомендуемое — вплотную к другому занятию
}
export interface TrialDay {
  label: string; // «Пн, 12 окт»
  weekday: string; // «Пн»
  slots: TrialSlot[]; // только свободные, по времени
}

function mskParts(iso: string): { wd: number; d: number; m: number } {
  const t = new Date(new Date(iso).getTime() + MSK_OFFSET_MINUTES * 60000);
  return { wd: t.getUTCDay(), d: t.getUTCDate(), m: t.getUTCMonth() };
}

// Свободные слоты на 7 суток вперёд от «сейчас» + offset недель. Это та же сетка,
// что видит ученик на сайте (рабочие окна, занятость календаря, «рекомендуем»), но
// под РАЗОВУЮ запись: пробное одно, следующие недели его не касаются.
//
// buildWeek группирует по дню НЕДЕЛИ и берёт ближайшее наступление каждого часа:
// в субботу днём «суббота» — это и сегодняшний вечер, и утро следующей субботы.
// Родителю нужны даты, поэтому раскладываем слоты по фактической дате (МСК) и
// упорядочиваем по времени.
export function trialDays(busy: BusyEvent[], now: Date, offset = 0): TrialDay[] {
  const from = new Date(now.getTime() + offset * WEEK_MS);
  const free = buildWeek(busy, from, { weeks: 1 })
    .flatMap((d) => d.slots)
    .filter((s) => !s.busy)
    .map((s) => ({ start: s.start, time: s.time, near: !!s.near }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const byDate = new Map<string, TrialDay>();
  for (const s of free) {
    const p = mskParts(s.start);
    const key = `${p.m}-${p.d}`;
    let day = byDate.get(key);
    if (!day) {
      day = { label: `${WD[p.wd]}, ${p.d} ${MON[p.m]}`, weekday: WD[p.wd], slots: [] };
      byDate.set(key, day);
    }
    day.slots.push(s);
  }
  return [...byDate.values()];
}

export async function loadTrialDays(now: Date, offset = 0): Promise<TrialDay[]> {
  const from = new Date(now.getTime() + offset * WEEK_MS);
  const { timeMin, timeMax } = weekWindowBounds(from, { weeks: 1 });
  return trialDays(await fetchBusy(timeMin, timeMax), now, offset);
}

// Подпись недели для шапки: «7–13 окт» / «28 сен – 4 окт».
export function weekRangeLabel(now: Date, offset = 0): string {
  const a = mskParts(new Date(now.getTime() + offset * WEEK_MS).toISOString());
  const b = mskParts(new Date(now.getTime() + offset * WEEK_MS + 6 * 86400000).toISOString());
  return a.m === b.m ? `${a.d}–${b.d} ${MON[b.m]}` : `${a.d} ${MON[a.m]} – ${b.d} ${MON[b.m]}`;
}

// Текст для родителя и слоты, которые в нём перечислены (под них — кнопки).
// По умолчанию только рекомендуемые: так преподаватель выбирал окна и вручную —
// день собирается плотным блоком. Рекомендуемых нет — показываем все свободные,
// иначе отправлять было бы нечего (fellBack говорит об этом шапке).
export function formatTrialWindows(
  days: TrialDay[],
  all: boolean
): { text: string; slots: TrialSlot[]; nearCount: number; fellBack: boolean } {
  const nearCount = days.reduce((n, d) => n + d.slots.filter((s) => s.near).length, 0);
  const fellBack = !all && nearCount === 0;
  const useAll = all || fellBack;
  const lines: string[] = [];
  const slots: TrialSlot[] = [];
  for (const d of days) {
    const picked = useAll ? d.slots : d.slots.filter((s) => s.near);
    if (!picked.length) continue;
    lines.push(`${d.label} — ${picked.map((s) => s.time).join(", ")}`);
    slots.push(...picked);
  }
  const text = lines.length
    ? `Свободное время для пробного занятия (МСК):\n${lines.join("\n")}`
    : "";
  return { text, slots, nearCount, fellBack };
}

// Предмет по ключевому слову: родитель пишет «ОГЭ», а в учёте — каноническое
// название из SUBJECTS (от него зависят тарифы ОГЭ/ЕГЭ при переводе в полноценные).
const SUBJECT_WORDS: { re: RegExp; subject: string }[] = [
  { re: /^огэ$/i, subject: "ОГЭ информатика" },
  { re: /^егэ$/i, subject: "ЕГЭ информатика" },
  { re: /^(питон|пайтон|python)$/i, subject: "Питон" },
  { re: /^(фронт|фронтенд|frontend|верстка|вёрстка)$/i, subject: "Фронтенд" },
];
// Слова, которые пишут рядом с предметом, но к имени они не относятся.
const FILLER = /^(пробное|пробный|пробник|по|информатика|информатике|информатику)$/i;

// «Маша ОГЭ», «Маша Иванова егэ @masha», «питон Петя» → имя, предмет, Telegram.
// Предмет не распознан — null: тогда бот спросит его кнопками.
export function parseTrialLine(line: string): {
  name: string;
  subject: string | null;
  tg: string;
} {
  let subject: string | null = null;
  let tg = "";
  const nameParts: string[] = [];
  for (const raw of line.trim().split(/\s+/)) {
    const w = raw.replace(/[,.;]+$/, "");
    if (!w) continue;
    if (/^@\w+$/.test(w)) {
      tg = w;
      continue;
    }
    const hit = SUBJECT_WORDS.find((s) => s.re.test(w));
    if (hit) {
      subject = subject ?? hit.subject;
      continue;
    }
    if (FILLER.test(w)) continue;
    nameParts.push(w);
  }
  return { name: nameParts.join(" "), subject, tg };
}

export type TrialBooking =
  | { ok: true; eventId: string; studentId: string; name: string; subject: string; start: string }
  | { ok: false; reason: string };

// Ставит пробное занятие сразу подтверждённым (его ставит сам преподаватель —
// подтверждать нечего) и заводит пробного ученика: у родителя появляется кабинет
// со ссылкой на звонок, напоминаниями и переносом, а после занятия — обычная
// кнопка «Сделать полноценным».
export async function bookTrialByTeacher(input: {
  startIso: string;
  name: string;
  subject: string;
  tg?: string;
  now?: Date;
}): Promise<TrialBooking> {
  const now = input.now ?? new Date();
  const name = input.name.trim();
  const subject = input.subject.trim();
  const tg = (input.tg || "").trim();
  if (!name) return { ok: false, reason: "Нет имени" };

  // Окно могло заняться, пока родитель думал: проверяем по свежему календарю.
  const span = new Date(new Date(input.startIso).getTime() + 2 * 3600000);
  const busy = await fetchBusy(now, span);
  const v = validateSlot(input.startIso, busy, now, 1);
  if (!v.ok || !v.end) return { ok: false, reason: v.reason || "Время недоступно" };

  // Тот же ключ, что у пробного из мастера «Новый ученик»: повторная запись того же
  // «Маша · ОГЭ» найдёт уже заведённого ученика, а не создаст двойника.
  const key = contactKey({ name, subject, tg, trial: true });
  const s = await upsertStudent({ name, subject, tg, contactKey: key, trial: true });

  const inserted = await calendarClient().events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: `${name} — ${subject}`,
      description: lessonDescription({
        student: name,
        subject,
        recurring: false,
        confirmed: true,
        trial: true,
        tg,
        meetLink: s.meetLink,
        boardLink: s.boardLink,
      }),
      start: { dateTime: input.startIso, timeZone: TIMEZONE },
      end: { dateTime: v.end.toISOString(), timeZone: TIMEZONE },
      status: "confirmed",
      extendedProperties: {
        private: {
          app: "zapis",
          status: "confirmed",
          contactKey: key,
          studentId: s.id,
          name,
          tg,
          student: name,
          subject,
          weeks: "1",
          lessons: "1",
        },
      },
    },
  });
  const eventId = inserted.data.id;
  if (!eventId) return { ok: false, reason: "Календарь не создал событие" };

  try {
    await recordLesson({
      studentId: s.id,
      calendarEventId: eventId,
      occurrenceStart: new Date(input.startIso),
      subject,
      status: "confirmed",
    });
  } catch (e) {
    console.error("trial: record lesson failed", e);
  }
  return { ok: true, eventId, studentId: s.id, name, subject, start: input.startIso };
}

// Отмена записи из того же экрана («ошибся временем/именем»). Ученика убираем,
// только если у него больше ничего нет: заведённый этой записью пробный не должен
// оставаться пустышкой в списке, а настоящий ученик с другими занятиями — остаётся.
export async function undoTrial(
  eventId: string,
  studentId: string
): Promise<{ removedStudent: boolean }> {
  try {
    await calendarClient().events.delete({ calendarId: CALENDAR_ID, eventId });
  } catch (e) {
    console.error("trial undo: event delete failed", eventId, e);
  }
  try {
    await setLessonStatusByEvent(eventId, "cancelled");
  } catch (e) {
    console.error("trial undo: lesson status failed", eventId, e);
  }
  const s = await getStudent(studentId);
  if (!s || !s.trial) return { removedStudent: false };
  const live = await liveEventIdsForContact(s.contactKey);
  if (live.size > 0) return { removedStudent: false };
  await deleteStudent(s.id);
  return { removedStudent: true };
}
