// Расчёт слотов записи. Всё считается и отображается в МСК (UTC+3, фиксированно).
// Для проверки пересечений с занятостью используем абсолютные моменты (UTC),
// поэтому события календаря в любой таймзоне учитываются корректно.
import {
  BOOKING_WINDOW_DAYS,
  MSK_OFFSET_MINUTES,
  SLOT_MINUTES,
  WORK_DAYS,
  WORK_END_HOUR,
  WORK_START_HOUR,
} from "./config";
import { BusyEvent } from "./google";

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

// Проверяет, что конкретный слот (по ISO-началу) валиден и свободен.
// Возвращает { ok, end } — end нужен для создания события.
export function validateSlot(
  startIso: string,
  busy: BusyEvent[],
  now = new Date()
): { ok: boolean; reason?: string; end?: Date } {
  const start = new Date(startIso);
  if (isNaN(start.getTime())) return { ok: false, reason: "Некорректное время" };
  if (start <= now) return { ok: false, reason: "Это время уже прошло" };

  // Слот должен попадать в сетку рабочих часов МСК.
  const shifted = new Date(start.getTime() + MSK_OFFSET_MINUTES * 60000);
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const weekday = shifted.getUTCDay();
  if (minute !== 0 || hour < WORK_START_HOUR || hour >= WORK_END_HOUR) {
    return { ok: false, reason: "Время вне рабочих часов" };
  }
  if (!WORK_DAYS.includes(weekday)) return { ok: false, reason: "Этот день недоступен" };

  const end = new Date(start.getTime() + SLOT_MINUTES * 60000);
  if (overlaps(start, end, busy)) return { ok: false, reason: "Слот уже занят" };
  return { ok: true, end };
}

// Форматирует момент как "7 июля, 10:00 (МСК)" для сообщений.
export function formatMsk(startIso: string): string {
  const shifted = new Date(new Date(startIso).getTime() + MSK_OFFSET_MINUTES * 60000);
  const dd = shifted.getUTCDate();
  const mm = shifted.getUTCMonth();
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const min = String(shifted.getUTCMinutes()).padStart(2, "0");
  const wd = WEEKDAYS_SHORT[shifted.getUTCDay()];
  return `${wd}, ${dd} ${MONTHS_GEN[mm]}, ${hh}:${min} (МСК)`;
}
