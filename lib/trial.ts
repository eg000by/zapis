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
  nextOccurrenceForContact,
  type BusyEvent,
} from "./google";
import {
  MONTHS_GEN,
  WEEKDAYS_SHORT,
  buildWeek,
  formatMskRange,
  mskDateParts,
  mskDayLabel,
  mskDayStart,
  validateSlot,
  weekWindowBounds,
} from "./slots";
import { TIMEZONE } from "./config";
import { contactKey } from "./link";
import { deleteStudent, getStudent, getStudentByContactKey, upsertStudent } from "./students";
import { listStudentLessons, recordLesson, setLessonStatusByEvent } from "./lessons";
import { listStudentPayments } from "./payments";
import { claimOnce, releaseClaim } from "./pings";

export interface TrialSlot {
  start: string; // ISO
  time: string; // «15:00» (МСК)
  near: boolean; // рекомендуемое — вплотную к другому занятию
}
export interface TrialDay {
  label: string; // «Пн, 13 октября»
  weekday: string; // «Пн»
  day: number; // 13 — для подписи кнопки
  slots: TrialSlot[]; // только свободные, по времени
}

// Страница окон — ровно 7 дат по МСК: 0 — сегодня … +6, 1 — +7 … +13 и т. д.
// Начало первой страницы — «сейчас» (прошедшие часы сегодня не нужны), остальных —
// полночь их первой даты.
function pageBounds(now: Date, offset: number): { from: Date; to: Date } {
  const nowIso = now.toISOString();
  return {
    from: offset === 0 ? now : mskDayStart(nowIso, 7 * offset),
    to: mskDayStart(nowIso, 7 * (offset + 1)),
  };
}

// Свободные слоты страницы. Сетка та же, что видит ученик на сайте (рабочие окна,
// занятость календаря, «рекомендуем»), но под РАЗОВУЮ запись: пробное одно, и
// следующие недели его не касаются.
//
// buildWeek группирует по дню НЕДЕЛИ и берёт ближайшее наступление каждого часа —
// в понедельник днём «понедельник» это и сегодняшний вечер, и утро следующего.
// Родителю нужны даты: раскладываем слоты по фактической дате и отрезаем всё, что
// за седьмой датой (оно — на следующей странице).
export function trialDays(busy: BusyEvent[], now: Date, offset = 0): TrialDay[] {
  const { from, to } = pageBounds(now, offset);
  const free = buildWeek(busy, from, { weeks: 1 })
    .flatMap((d) => d.slots)
    .filter((s) => !s.busy && new Date(s.start) < to)
    .map((s) => ({ start: s.start, time: s.time, near: !!s.near }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const byDate = new Map<string, TrialDay>();
  for (const s of free) {
    const p = mskDateParts(s.start);
    const key = `${p.y}-${p.m}-${p.d}`;
    let day = byDate.get(key);
    if (!day) {
      day = { label: mskDayLabel(s.start), weekday: WEEKDAYS_SHORT[p.wd], day: p.d, slots: [] };
      byDate.set(key, day);
    }
    day.slots.push(s);
  }
  return [...byDate.values()];
}

export async function loadTrialDays(now: Date, offset = 0): Promise<TrialDay[]> {
  const { from } = pageBounds(now, offset);
  const { timeMin, timeMax } = weekWindowBounds(from, { weeks: 1 });
  return trialDays(await fetchBusy(timeMin, timeMax), now, offset);
}

// Подпись страницы для шапки — те же 7 дат: «6–12 октября» / «28 сентября – 4 октября».
export function weekRangeLabel(now: Date, offset = 0): string {
  const nowIso = now.toISOString();
  const a = mskDateParts(mskDayStart(nowIso, 7 * offset).toISOString());
  const b = mskDateParts(mskDayStart(nowIso, 7 * offset + 6).toISOString());
  return a.m === b.m
    ? `${a.d}–${b.d} ${MONTHS_GEN[b.m]}`
    : `${a.d} ${MONTHS_GEN[a.m]} – ${b.d} ${MONTHS_GEN[b.m]}`;
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
// название из SUBJECTS (от него зависят тарифы ОГЭ/ЕГЭ и ключ ученика: «огэ» и
// «ОГЭ информатика» иначе стали бы двумя разными учениками).
const SUBJECT_WORDS: { re: RegExp; subject: string }[] = [
  { re: /^огэ$/i, subject: "ОГЭ информатика" },
  { re: /^егэ$/i, subject: "ЕГЭ информатика" },
  { re: /^(питон|пайтон|python)$/i, subject: "Питон" },
  { re: /^(фронт|фронтенд|frontend|верстка|вёрстка)$/i, subject: "Фронтенд" },
];
// Слова, которые пишут рядом с предметом, но к имени они не относятся.
const FILLER = /^(пробное|пробный|пробник|по|информатика|информатике|информатику)$/i;

const words = (line: string) =>
  line
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[,.;]+$/, ""))
    .filter(Boolean);

const subjectOf = (w: string) => SUBJECT_WORDS.find((s) => s.re.test(w))?.subject ?? null;

// Предмет, написанный словами: знакомое ключевое слово → каноническое название,
// иначе — как написали («Робототехника»).
export function normalizeSubject(text: string): string {
  for (const w of words(text)) {
    const hit = subjectOf(w);
    if (hit) return hit;
  }
  return text.trim();
}

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
  for (const w of words(line)) {
    if (/^@\w+$/.test(w)) {
      tg = w;
      continue;
    }
    const hit = subjectOf(w);
    if (hit) {
      subject = subject ?? hit;
      continue;
    }
    if (FILLER.test(w)) continue;
    nameParts.push(w);
  }
  return { name: nameParts.join(" "), subject, tg };
}

export type TrialBooking =
  | {
      ok: true;
      eventId: string;
      studentId: string;
      name: string;
      subject: string;
      start: string;
      trial: boolean; // false — разовое занятие уже существующему ученику
    }
  | {
      ok: false;
      // exists — такой ученик уже есть и он не пробный: бот спросит, что делать.
      code: "invalid" | "taken" | "exists" | "has_trial" | "busy" | "error";
      reason: string;
    };

// «Занятость» записи: двойное нажатие — это два апдейта Telegram, и оба успели бы
// пройти проверку слота до того, как первый поставит событие.
// Время приводим к ISO: Google отдаёт его со смещением («…+03:00»), а ключ при
// записи и при отмене должен совпасть.
const claimKey = (key: string, start: string) => `trial:${key}:${new Date(start).toISOString()}`;

// Ставит пробное занятие сразу подтверждённым (его ставит сам преподаватель —
// подтверждать нечего) и заводит пробного ученика: у родителя появляется кабинет
// со ссылкой на звонок, напоминаниями и переносом, а после занятия — обычная
// кнопка «Сделать полноценным».
//
// toExisting — такой ученик уже есть (имя + предмет + Telegram совпали) и он не
// пробный: записать ему обычное разовое занятие. Без флага такой случай
// возвращается кодом exists, чтобы не повесить «пробное» на настоящего ученика.
export async function bookTrialByTeacher(input: {
  startIso: string;
  name: string;
  subject: string;
  tg?: string;
  toExisting?: boolean;
  now?: Date;
}): Promise<TrialBooking> {
  const now = input.now ?? new Date();
  const name = input.name.trim();
  const subject = input.subject.trim();
  const tg = (input.tg || "").trim();
  if (!name) return { ok: false, code: "invalid", reason: "Нет имени" };

  // Окно могло заняться, пока родитель думал: проверяем по свежему календарю.
  const busy = await fetchBusy(now, new Date(new Date(input.startIso).getTime() + 2 * 3600000));
  const v = validateSlot(input.startIso, busy, now, 1);
  if (!v.ok || !v.end) return { ok: false, code: "taken", reason: v.reason || "Время недоступно" };

  // Тот же ключ, что у ученика из мастера «Новый ученик»: повторная запись того же
  // «Маша · ОГЭ» найдёт уже заведённого ученика, а не создаст двойника.
  const key = contactKey({ name, subject, tg, trial: true });
  const existing = await getStudentByContactKey(key);
  if (existing && !existing.trial && !input.toExisting) {
    return {
      ok: false,
      code: "exists",
      reason: `${name} · ${subject} уже есть среди учеников (не пробный)`,
    };
  }
  // Пробное одно — то же правило, что на сайте: у пробного ученика уже стоит
  // будущее занятие — второе не ставим, лучше перенести первое.
  if (existing?.trial) {
    const upcoming = await nextOccurrenceForContact(key).catch(() => null);
    if (upcoming) {
      return {
        ok: false,
        code: "has_trial",
        reason: `у ${name} уже есть пробное: ${formatMskRange(upcoming, 1)}`,
      };
    }
  }

  // Сбой БД не должен срывать запись — проверка дублей тогда просто пропускается.
  const claimed = await claimOnce(claimKey(key, input.startIso)).catch(() => true);
  if (!claimed) return { ok: false, code: "busy", reason: "эта запись уже выполняется" };

  const trial = existing ? existing.trial : true;
  const s = existing ?? (await upsertStudent({ name, subject, tg, contactKey: key, trial: true }));

  let eventId: string | null | undefined;
  try {
    const inserted = await calendarClient().events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${name} — ${subject}`,
        description: lessonDescription({
          student: name,
          subject,
          recurring: false,
          confirmed: true,
          trial,
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
    eventId = inserted.data.id;
  } catch (e) {
    console.error("trial: calendar insert failed", e);
  }
  if (!eventId) {
    // Занятие не встало — заведённый ради него ученик был бы пустышкой в списке.
    if (!existing) await deleteStudent(s.id).catch((e) => console.error("trial: rollback student", e));
    await releaseClaim(claimKey(key, input.startIso)).catch(() => {});
    return { ok: false, code: "error", reason: "календарь не ответил — попробуйте ещё раз" };
  }

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
  return { ok: true, eventId, studentId: s.id, name, subject, start: input.startIso, trial };
}

export type TrialUndo =
  | { ok: true; removedStudent: boolean }
  | { ok: false; reason: string };

// Отмена записи с экрана итога («ошибся временем или именем»). Только пока занятие
// не началось: кнопка живёт в переписке вечно, и случайное нажатие через неделю не
// должно ничего сносить. Ученика убираем, только если он — пустышка, заведённая
// этой записью: пробный, без других занятий, без заметок и без оплат. Всё, что
// старше и содержательнее, остаётся.
export async function undoTrial(
  eventId: string,
  studentId: string,
  now = new Date()
): Promise<TrialUndo> {
  const cal = calendarClient();
  let ev;
  try {
    ev = (await cal.events.get({ calendarId: CALENDAR_ID, eventId })).data;
  } catch (e: any) {
    if (e?.code !== 404 && e?.code !== 410) {
      console.error("trial undo: event get failed", eventId, e);
      return { ok: false, reason: "Календарь не ответил — занятие не снято, попробуйте ещё раз" };
    }
    ev = null; // уже удалено
  }
  const start = ev?.start?.dateTime || "";
  if (ev && ev.status !== "cancelled") {
    if (start && new Date(start).getTime() <= now.getTime()) {
      return { ok: false, reason: "Занятие уже началось — отменить его отсюда нельзя" };
    }
    try {
      await cal.events.delete({ calendarId: CALENDAR_ID, eventId });
    } catch (e) {
      console.error("trial undo: event delete failed", eventId, e);
      return { ok: false, reason: "Календарь не ответил — занятие не снято, попробуйте ещё раз" };
    }
  }
  await setLessonStatusByEvent(eventId, "cancelled").catch((e) =>
    console.error("trial undo: lesson status failed", eventId, e)
  );
  const key = ev?.extendedProperties?.private?.contactKey;
  if (key && start) await releaseClaim(claimKey(key, start)).catch(() => {});

  const s = await getStudent(studentId);
  if (!s || !s.trial) return { ok: true, removedStudent: false };
  const [live, payments, lessons] = await Promise.all([
    liveEventIdsForContact(s.contactKey),
    listStudentPayments(s.id),
    listStudentLessons(s.id, 50),
  ]);
  const hasContent = payments.length > 0 || lessons.some((l) => l.note || l.status === "done");
  if (live.size > 0 || hasContent) return { ok: true, removedStudent: false };
  await deleteStudent(s.id);
  return { ok: true, removedStudent: true };
}
