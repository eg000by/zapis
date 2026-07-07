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
export async function fetchBusy(timeMin: Date, timeMax: Date): Promise<BusyEvent[]> {
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
    // Пропускаем события, где сам пользователь отметил "нет" — они не занимают время.
    // (для календаря репетитора это не критично, но безопасно.)
    const s = ev.start?.dateTime || ev.start?.date;
    const e = ev.end?.dateTime || ev.end?.date;
    if (!s || !e) continue;
    busy.push({ start: new Date(s), end: new Date(e) });
  }
  return busy;
}
