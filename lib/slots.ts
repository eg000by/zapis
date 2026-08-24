// Расчёт слотов записи. Всё считается и отображается в МСК (UTC+3, фиксированно).
// Для проверки пересечений с занятостью используем абсолютные моменты (UTC),
// поэтому события календаря в любой таймзоне учитываются корректно.
import {
  AVAILABILITY_WEEKS,
  BOOKING_WINDOW_DAYS,
  MSK_OFFSET_MINUTES,
  SLOT_MINUTES,
  SLOT_STEP_MINUTES,
  TIMEZONE,
  dayWindow,
} from "./config";

// Длительность блока из `lessons` подряд идущих занятий, в минутах:
// N уроков по SLOT_MINUTES с перерывами между ними (шаг SLOT_STEP_MINUTES).
export function blockSpanMinutes(lessons: number): number {
  return (Math.max(1, lessons) - 1) * SLOT_STEP_MINUTES + SLOT_MINUTES;
}
import type { BusyEvent } from "./google";

const WEEKDAYS_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const WEEKDAYS_FULL = [
  "Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота",
];
// Порядок обезличенной недели: понедельник → воскресенье.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

export interface Slot {
  start: string; // ISO-момент начала слота
  time: string; // "10:00" в МСК
  busy: boolean;
}

export interface DaySlots {
  date: string; // YYYY-MM-DD (по МСК)
  title: string; // "Пн, 7 июля"
  weekday: string; // "Пн"
  slots: Slot[];
  closed: boolean; // выходной: день показывается в сетке, но записи нет
}

// Переводит "стеночное" время МСК в абсолютный момент (МСК = UTC+3, без DST).
function mskWallToInstant(y: number, m: number, d: number, hh: number, mm = 0): Date {
  return new Date(Date.UTC(y, m, d, hh, mm) - MSK_OFFSET_MINUTES * 60000);
}

// Текущий момент, выраженный в "стеночных" полях МСК.
function mskNowParts(now: Date): { y: number; m: number; d: number } {
  const shifted = new Date(now.getTime() + MSK_OFFSET_MINUTES * 60000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

function overlaps(slotStart: Date, slotEnd: Date, busy: BusyEvent[]): boolean {
  for (const b of busy) {
    if (b.start < slotEnd && b.end > slotStart) return true;
  }
  return false;
}

// Границы окна запроса к календарю: от текущего момента до конца окна записи.
export function windowBounds(now = new Date()): { timeMin: Date; timeMax: Date } {
  const { y, m, d } = mskNowParts(now);
  const timeMin = now;
  const timeMax = mskWallToInstant(y, m, d + BOOKING_WINDOW_DAYS + 1, 0);
  return { timeMin, timeMax };
}

// Для чего строится сетка. От этого зависит, на сколько наступлений вперёд
// проверяется занятость слота, — и это ровно то же правило, по которому запись
// потом проверяется на сервере.
export interface WeekOptions {
  // Сколько недель подряд слот должен быть свободен. Еженедельная серия занимает
  // время надолго (AVAILABILITY_WEEKS), разовая запись — только один раз (1).
  weeks?: number;
  // Разовый перенос: ISO занятия, которое двигают. Слоты сдвигаются к его дате
  // (ближайшее наступление в пределах ±полнедели), weeks при этом равен 1.
  occIso?: string;
  // «Другая дата»: ISO любой даты — сетка показывает КАЛЕНДАРНУЮ неделю (Пн–Вс),
  // в которую эта дата попадает, а не ближайшую. Именно календарную, а не «±3 дня
  // вокруг даты» (как occIso): ученик видит недельную сетку и должен получить
  // ровно ту неделю, что выбрал, — иначе воскресенье уезжало бы в прошлую.
  fromIso?: string;
}

// Окно занятости для обезличенной недели: нужно покрыть ближайшее наступление
// каждого слота (до 7 дней вперёд) и ещё weeks−1 повторений. Для разового
// переноса окно тянется до недели переносимого занятия — иначе занятость на той
// неделе просто не попала бы в ответ календаря и все слоты казались бы свободными.
export function weekWindowBounds(
  now = new Date(),
  opts: WeekOptions = {}
): { timeMin: Date; timeMax: Date } {
  const timeMin = now;
  const weeks = Math.max(1, opts.weeks ?? AVAILABILITY_WEEKS);
  // Сетку сдвинули на другую неделю — занятость нужна вокруг НЕЁ, иначе ответ
  // календаря её просто не покрывает и все слоты выглядят свободными.
  const anchor = opts.fromIso || opts.occIso;
  if (anchor) {
    const from = Math.max(new Date(anchor).getTime(), now.getTime());
    // +7 суток на саму неделю и по 7 на каждое следующее проверяемое повторение.
    return { timeMin, timeMax: new Date(from + (weeks * 7 + 1) * 86400000) };
  }
  const { y, m, d } = mskNowParts(now);
  // +7 дней на ближайшее наступление + недели повторений + сутки запаса.
  const timeMax = mskWallToInstant(y, m, d + 7 + weeks * 7 + 1, 0);
  return { timeMin, timeMax };
}

// Понедельник 00:00 МСК той недели, в которую попадает момент.
function mskMondayOf(d: Date): { y: number; m: number; day: number } {
  const shifted = new Date(d.getTime() + MSK_OFFSET_MINUTES * 60000);
  const wd = shifted.getUTCDay(); // 0 = вс
  const back = (wd + 6) % 7; // сколько дней назад до понедельника
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    day: shifted.getUTCDate() - back,
  };
}

// Ближайшее будущее наступление слота (день недели + время hh:mm) в МСК.
function nextOccurrence(weekday: number, hh: number, mm: number, now: Date): Date {
  const { y, m, d } = mskNowParts(now);
  const todayWd = new Date(Date.UTC(y, m, d, 12)).getUTCDay();
  const delta = (weekday - todayWd + 7) % 7;
  let cand = mskWallToInstant(y, m, d + delta, hh, mm);
  // Если сегодняшнее наступление уже прошло — берём это же время через неделю.
  if (cand.getTime() <= now.getTime()) cand = new Date(cand.getTime() + 7 * 86400000);
  return cand;
}

// Строит «обезличенную» неделю: доступные дни (из WORK_HOURS) со своей сеткой слотов —
// у каждого дня своё рабочее окно. start слота — ISO момента, на который запись
// реально уйдёт, а busy считается ровно по тем наступлениям, которые она займёт:
//
//   еженедельная серия  — ближайшее наступление + AVAILABILITY_WEEKS−1 повторений
//                         (время закрепляется надолго, занятое через неделю не годится);
//   разовая запись      — только ближайшее наступление (пробное занятие одно);
//   разовый перенос     — только та дата, в неделю которой сдвинут слот.
//
// Правило «одно занятие — одна проверка» и есть суть: раньше сетка была общей и
// требовала свободных четырёх недель подряд даже там, где занимается один час.
//
// opts.fromIso сдвигает всю сетку на календарную неделю выбранной даты («записаться
// не с ближайшей недели, а с любой другой»). Слоты, которые в этой неделе уже
// прошли, не показываем вовсе — записаться в прошлое всё равно нельзя.
export function buildWeek(
  busy: BusyEvent[],
  now = new Date(),
  opts: WeekOptions = {}
): DaySlots[] {
  const days: DaySlots[] = [];
  const weeks = opts.occIso ? 1 : Math.max(1, opts.weeks ?? AVAILABILITY_WEEKS);
  // Понедельник выбранной недели — точка отсчёта для fromIso.
  const monday = opts.fromIso ? mskMondayOf(new Date(opts.fromIso)) : null;

  for (const weekday of WEEK_ORDER) {
    const win = dayWindow(weekday);
    // Выходной: день остаётся в сетке (чтобы неделя была видна целиком), но без слотов.
    if (!win) {
      days.push({
        date: `wd-${weekday}`,
        weekday: WEEKDAYS_SHORT[weekday],
        title: WEEKDAYS_FULL[weekday],
        slots: [],
        closed: true,
      });
      continue;
    }
    const startMin = win.start * 60;
    const endMin = win.end * 60;

    const slots: Slot[] = [];
    // Шаг сетки — SLOT_STEP_MINUTES (занятие + перерыв). Последний урок должен
    // закончиться не позже WORK_END_HOUR.
    for (let min = startMin; min + SLOT_MINUTES <= endMin; min += SLOT_STEP_MINUTES) {
      const hr = Math.floor(min / 60);
      const mn = min % 60;
      // Сдвиг на другую неделю делает сервер, чтобы дата в чипе дня, проверка
      // занятости и время, которое уйдёт в запись, были одним и тем же моментом.
      let start: Date;
      if (monday) {
        // Выбранная календарная неделя: понедельник + номер дня недели.
        start = mskWallToInstant(monday.y, monday.m, monday.day + WEEK_ORDER.indexOf(weekday), hr, mn);
        if (start.getTime() <= now.getTime()) continue; // этот час уже прошёл
      } else {
        const first = nextOccurrence(weekday, hr, mn, now);
        // Разовый перенос — неделя переносимого занятия вместо ближайшей.
        start = opts.occIso
          ? new Date(shiftIntoWeekOf(first.toISOString(), opts.occIso, now))
          : first;
      }

      let isBusy = false;
      for (let w = 0; w < weeks; w++) {
        const s = new Date(start.getTime() + w * 7 * 86400000);
        const e = new Date(s.getTime() + SLOT_MINUTES * 60000);
        if (overlaps(s, e, busy)) {
          isBusy = true;
          break;
        }
      }

      slots.push({
        start: start.toISOString(),
        time: `${String(hr).padStart(2, "0")}:${String(mn).padStart(2, "0")}`,
        busy: isBusy,
      });
    }

    days.push({
      date: `wd-${weekday}`, // синтетический стабильный ключ (не дата)
      weekday: WEEKDAYS_SHORT[weekday],
      title: WEEKDAYS_FULL[weekday],
      slots,
      closed: false,
    });
  }

  return days;
}

// Проверяет, что блок из `lessons` подряд идущих занятий (начиная с ISO-начала)
// валиден и полностью свободен. Для обычного слота lessons = 1.
// Старт обязан попадать в сетку (кратен шагу от начала рабочего дня), а весь блок
// (уроки + внутренние перерывы) — умещаться в рабочие часы.
// Возвращает { ok, end } — end нужен для создания события.
export function validateSlot(
  startIso: string,
  busy: BusyEvent[],
  now = new Date(),
  lessons = 1
): { ok: boolean; reason?: string; end?: Date } {
  const start = new Date(startIso);
  if (isNaN(start.getTime())) return { ok: false, reason: "Некорректное время" };
  if (start <= now) return { ok: false, reason: "Это время уже прошло" };

  // Блок должен попадать в сетку рабочих часов МСК своего дня недели.
  const shifted = new Date(start.getTime() + MSK_OFFSET_MINUTES * 60000);
  const minutesOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const weekday = shifted.getUTCDay();
  const win = dayWindow(weekday);
  if (!win) return { ok: false, reason: "Этот день недоступен" };
  const offset = minutesOfDay - win.start * 60;
  const span = blockSpanMinutes(lessons);
  if (offset < 0 || offset % SLOT_STEP_MINUTES !== 0) {
    return { ok: false, reason: "Время вне сетки" };
  }
  if (win.start * 60 + offset + span > win.end * 60) {
    return { ok: false, reason: "Время вне рабочих часов" };
  }

  const end = new Date(start.getTime() + span * 60000);
  if (overlaps(start, end, busy)) return { ok: false, reason: "Слот уже занят" };
  return { ok: true, end };
}

// Возвращает ISO-моменты еженедельных повторений слота (первое = сам слот).
// МСК фиксирован (UTC+3, без перехода на летнее время), поэтому +7 суток
// сохраняет то же «стеночное» время.
export function weeklyOccurrences(startIso: string, weeks: number): string[] {
  const base = new Date(startIso).getTime();
  const out: string[] = [];
  for (let w = 0; w < Math.max(1, weeks); w++) {
    out.push(new Date(base + w * 7 * 86400000).toISOString());
  }
  return out;
}

// Момент в формате EXDATE/DTSTART по «стеночному» времени МСК: "20260722T100000".
function mskWallStamp(iso: string): string {
  const d = new Date(new Date(iso).getTime() + MSK_OFFSET_MINUTES * 60000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`
  );
}

// Готовит правило повторения для события.
// Первое занятие (выбранный слот) обязано быть свободным. Недели, где вы уже
// заняты, автоматически исключаются через EXDATE — вся серия из-за них не падает.
// Для weeks<=1 повторения нет (recurrence = undefined).
export function buildRecurrence(
  startIso: string,
  weeks: number,
  busy: BusyEvent[],
  now = new Date(),
  lessons = 1
): { ok: boolean; reason?: string; recurrence?: string[]; end?: Date } {
  const occ = weeklyOccurrences(startIso, weeks);
  const first = validateSlot(occ[0], busy, now, lessons);
  if (!first.ok) return { ok: false, reason: first.reason };
  if (weeks <= 1) return { ok: true, end: first.end };

  const exdates: string[] = [];
  for (let i = 1; i < occ.length; i++) {
    if (!validateSlot(occ[i], busy, now, lessons).ok) exdates.push(mskWallStamp(occ[i]));
  }
  const recurrence = [`RRULE:FREQ=WEEKLY;COUNT=${weeks}`];
  if (exdates.length) recurrence.push(`EXDATE;TZID=${TIMEZONE}:${exdates.join(",")}`);
  return { ok: true, recurrence, end: first.end };
}

// Сдвигает выбранный слот сетки (ближайшее наступление дня недели) в неделю
// переносимого занятия occIso: разовый перенос занятия «через 3 недели» не должен
// уезжать на текущую неделю. Если после сдвига время оказалось в прошлом — берём
// неделей позже.
export function shiftIntoWeekOf(startIso: string, occIso: string, now = new Date()): string {
  const WEEK = 7 * 86400000;
  const shift = Math.round((new Date(occIso).getTime() - new Date(startIso).getTime()) / WEEK);
  let t = new Date(startIso).getTime() + shift * WEEK;
  if (t <= now.getTime()) t += WEEK;
  return new Date(t).toISOString();
}

// Форматирует блок как "Ср, 7 июля, 10:00–12:10 (МСК)" для сообщений.
// Для одного занятия диапазон не показываем: "Ср, 7 июля, 10:00 (МСК)".
export function formatMskRange(startIso: string, lessons = 1): string {
  const s = new Date(new Date(startIso).getTime() + MSK_OFFSET_MINUTES * 60000);
  const p = (n: number) => String(n).padStart(2, "0");
  const dd = s.getUTCDate();
  const mm = s.getUTCMonth();
  const wd = WEEKDAYS_SHORT[s.getUTCDay()];
  const startLabel = `${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`;
  if (lessons <= 1) return `${wd}, ${dd} ${MONTHS_GEN[mm]}, ${startLabel} (МСК)`;
  const e = new Date(s.getTime() + blockSpanMinutes(lessons) * 60000);
  const endLabel = `${p(e.getUTCHours())}:${p(e.getUTCMinutes())}`;
  return `${wd}, ${dd} ${MONTHS_GEN[mm]}, ${startLabel}–${endLabel} (МСК)`;
}

// Форматирует момент как "Ср, 7 июля, 10:00 (МСК)" для сообщений.
export function formatMsk(startIso: string): string {
  return formatMskRange(startIso, 1);
}
