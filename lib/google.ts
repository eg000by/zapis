// Клиент Google Calendar через сервисный аккаунт.
import { google, calendar_v3 } from "googleapis";

export const CALENDAR_ID = process.env.CALENDAR_ID || "primary";

let cached: calendar_v3.Calendar | null = null;

export function calendarClient(): calendar_v3.Calendar {
  if (cached) return cached;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN не заданы"
    );
  }
  // OAuth: ходим в календарь под самим пользователем. Access-token библиотека
  // обновляет автоматически по refresh-token.
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  cached = google.calendar({ version: "v3", auth });
  return cached;
}

export interface BusyEvent {
  start: Date;
  end: Date;
}

// Возвращает занятые интервалы (абсолютные моменты) за окно [timeMin, timeMax).
// Учитываются подтверждённые и предварительные (tentative) события — оба держат слот.
// excludeId — id события, которое не учитываем (нужно при переносе: чтобы запись
// не конфликтовала сама с собой).
export async function fetchBusy(
  timeMin: Date,
  timeMax: Date,
  excludeId?: string
): Promise<BusyEvent[]> {
  const cal = calendarClient();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500,
  });
  const items = res.data.items || [];
  const busy: BusyEvent[] = [];
  for (const ev of items) {
    if (ev.status === "cancelled") continue;
    if (excludeId && (ev.id === excludeId || ev.recurringEventId === excludeId)) continue;
    // Пропускаем события, где сам пользователь отметил "нет" — они не занимают время.
    // (для календаря репетитора это не критично, но безопасно.)
    const s = ev.start?.dateTime || ev.start?.date;
    const e = ev.end?.dateTime || ev.end?.date;
    if (!s || !e) continue;
    busy.push({ start: new Date(s), end: new Date(e) });
  }
  return busy;
}

// Запись в упрощённом виде — для экрана «Мои записи».
export interface BookingEvent {
  id: string;
  student: string;
  subject: string;
  status: string; // "pending" | "confirmed"
  start: string; // ISO начала (для повторяющихся — первое занятие)
  recurring: boolean;
  weeks: number;
  lessons: number; // число занятий в блоке (для отображения диапазона и лимита)
}

// Возвращает записи владельца ссылки (по contactKey), у которых есть будущие
// занятия. Повторяющиеся серии возвращаются одной строкой (singleEvents=false).
export async function listContactEvents(key: string, fromIso: string): Promise<BookingEvent[]> {
  const cal = calendarClient();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: ["app=zapis", `contactKey=${key}`],
    timeMin: fromIso,
    singleEvents: false,
    maxResults: 100,
  });
  const items = res.data.items || [];
  const out: BookingEvent[] = [];
  for (const ev of items) {
    if (ev.status === "cancelled") continue;
    const start = ev.start?.dateTime || ev.start?.date;
    if (!ev.id || !start) continue;
    const priv = ev.extendedProperties?.private || {};
    const weeks = Number(priv.weeks) || 1;
    // Число занятий в блоке хранится в extendedProperties. Для старых событий
    // (без поля) оцениваем по длительности из расчёта 60 мин на занятие.
    const end = ev.end?.dateTime || ev.end?.date;
    const lessons =
      Number(priv.lessons) ||
      (end
        ? Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 3600000))
        : 1);
    out.push({
      id: ev.id,
      student: priv.student || "",
      subject: priv.subject || "",
      status: priv.status || "pending",
      start: new Date(start).toISOString(),
      recurring: Array.isArray(ev.recurrence) && ev.recurrence.length > 0,
      weeks,
      lessons,
    });
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}
