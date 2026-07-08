// Расчёт слотов записи. Всё считается и отображается в МСК (UTC+3, фиксированно).
// Для проверки пересечений с занятостью используем абсолютные моменты (UTC),
// поэтому события календаря в любой таймзоне учитываются корректно.
import {
  BOOKING_WINDOW_DAYS,
  MSK_OFFSET_MINUTES,
  SLOT_MINUTES,
  TIMEZONE,
  WORK_DAYS,
  WORK_END_HOUR,
  WORK_START_HOUR,
} from "./config";
import type { BusyEvent } from "./google";

const WEEKDAYS_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
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

// Строит сетку дней со слотами. Прошедшие слоты не включаются.
// В результат попадают только дни, где есть хотя бы один будущий слот.
export function buildDays(busy: BusyEvent[], now = new Date()): DaySlots[] {
  const { y, m, d } = mskNowParts(now);
  const days: DaySlots[] = [];

  for (let i = 0; i < BOOKING_WINDOW_DAYS; i++) {
    // Опорная дата МСК (полдень, чтобы не съехать на границах месяца).
    const ref = new Date(Date.UTC(y, m, d + i, 12));
    const yy = ref.getUTCFullYear();
    const mm = ref.getUTCMonth();
    const dd = ref.getUTCDate();
    const weekday = ref.getUTCDay();

    if (!WORK_DAYS.includes(weekday)) continue;

    const slots: Slot[] = [];
    for (let hour = WORK_START_HOUR; hour < WORK_END_HOUR; hour++) {
      const start = mskWallToInstant(yy, mm, dd, hour);
      const end = new Date(start.getTime() + SLOT_MINUTES * 60000);
      if (start <= now) continue; // прошедшие слоты не показываем
      slots.push({
        start: start.toISOString(),
        time: `${String(hour).padStart(2, "0")}:00`,
        busy: overlaps(start, end, busy),
      });
    }

    if (slots.length === 0) continue;

    days.push({
      date: `${yy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
      weekday: WEEKDAYS_SHORT[weekday],
      title: `${WEEKDAYS_SHORT[weekday]}, ${dd} ${MONTHS_GEN[mm]}`,
      slots,
    });
  }

  return days;
}

// Проверяет, что блок из `hours` подряд идущих часов (начиная с ISO-начала)
// валиден и полностью свободен. Для обычного слота hours = 1.
// Возвращает { ok, end } — end нужен для создания события.
export function validateSlot(
  startIso: string,
  busy: BusyEvent[],
  now = new Date(),
  hours = 1
): { ok: boolean; reason?: string; end?: Date } {
  const start = new Date(startIso);
  if (isNaN(start.getTime())) return { ok: false, reason: "Некорректное время" };
  if (start <= now) return { ok: false, reason: "Это время уже прошло" };

  // Блок должен целиком попадать в сетку рабочих часов МСК.
  const shifted = new Date(start.getTime() + MSK_OFFSET_MINUTES * 60000);
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const weekday = shifted.getUTCDay();
  if (minute !== 0 || hour < WORK_START_HOUR || hour + hours > WORK_END_HOUR) {
    return { ok: false, reason: "Время вне рабочих часов" };
  }
  if (!WORK_DAYS.includes(weekday)) return { ok: false, reason: "Этот день недоступен" };

  const end = new Date(start.getTime() + hours * SLOT_MINUTES * 60000);
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
  hours = 1
): { ok: boolean; reason?: string; recurrence?: string[]; end?: Date } {
  const occ = weeklyOccurrences(startIso, weeks);
  const first = validateSlot(occ[0], busy, now, hours);
  if (!first.ok) return { ok: false, reason: first.reason };
  if (weeks <= 1) return { ok: true, end: first.end };

  const exdates: string[] = [];
  for (let i = 1; i < occ.length; i++) {
    if (!validateSlot(occ[i], busy, now, hours).ok) exdates.push(mskWallStamp(occ[i]));
  }
  const recurrence = [`RRULE:FREQ=WEEKLY;COUNT=${weeks}`];
  if (exdates.length) recurrence.push(`EXDATE;TZID=${TIMEZONE}:${exdates.join(",")}`);
  return { ok: true, recurrence, end: first.end };
}

// Форматирует блок как "Ср, 7 июля, 10:00–13:00 (МСК)" для сообщений.
// Для одного часа диапазон не показываем: "Ср, 7 июля, 10:00 (МСК)".
export function formatMskRange(startIso: string, hours = 1): string {
  const s = new Date(new Date(startIso).getTime() + MSK_OFFSET_MINUTES * 60000);
  const p = (n: number) => String(n).padStart(2, "0");
  const dd = s.getUTCDate();
  const mm = s.getUTCMonth();
  const wd = WEEKDAYS_SHORT[s.getUTCDay()];
  const startLabel = `${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`;
  if (hours <= 1) return `${wd}, ${dd} ${MONTHS_GEN[mm]}, ${startLabel} (МСК)`;
  const e = new Date(s.getTime() + hours * SLOT_MINUTES * 60000);
  const endLabel = `${p(e.getUTCHours())}:${p(e.getUTCMinutes())}`;
  return `${wd}, ${dd} ${MONTHS_GEN[mm]}, ${startLabel}–${endLabel} (МСК)`;
}

// Форматирует момент как "Ср, 7 июля, 10:00 (МСК)" для сообщений.
export function formatMsk(startIso: string): string {
  return formatMskRange(startIso, 1);
}
