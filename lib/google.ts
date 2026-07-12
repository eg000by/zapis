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

// Ставит (или снимает при colorId=null) цвет события/инстанса Google Calendar.
// Для мастера повторяющейся серии красит всю серию; для отдельного инстанса —
// только его (создаётся исключение). patch меняет только цвет, остальное не трогает.
export async function setEventColor(eventId: string, colorId: string | null): Promise<void> {
  const cal = calendarClient();
  await cal.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: { colorId },
  });
}

// Одно занятие (инстанс серии или одиночное событие) для поштучной покраски.
export interface ColorOccurrence {
  instanceId: string; // id, на который вешаем цвет (инстанс повтора или само событие)
  start: Date;
  hours: number; // длина блока в часах (для балансовой покраски «всё-или-ничего»)
  colorId: string | null; // текущий цвет (чтобы не патчить лишний раз)
}

// Мастер-события ученика (повторяющиеся — одной строкой) для сброса цвета серии.
export async function listContactMasters(
  key: string
): Promise<{ id: string; colorId: string | null }[]> {
  const cal = calendarClient();
  const now = Date.now();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: ["app=zapis", `contactKey=${key}`],
    timeMin: new Date(now - 400 * 86400000).toISOString(),
    timeMax: new Date(now + 400 * 86400000).toISOString(),
    singleEvents: false,
    maxResults: 250,
  });
  const out: { id: string; colorId: string | null }[] = [];
  for (const ev of res.data.items || []) {
    if (ev.status === "cancelled" || !ev.id) continue;
    if ((ev.extendedProperties?.private?.status || "pending") !== "confirmed") continue;
    out.push({ id: ev.id, colorId: ev.colorId ?? null });
  }
  return out;
}

// Все подтверждённые занятия ученика поштучно (повторы развёрнуты в инстансы),
// по возрастанию времени — для балансовой покраски оплачено/нет × прошлое/будущее.
export async function listContactOccurrences(key: string): Promise<ColorOccurrence[]> {
  const cal = calendarClient();
  const now = Date.now();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: ["app=zapis", `contactKey=${key}`],
    timeMin: new Date(now - 400 * 86400000).toISOString(),
    timeMax: new Date(now + 400 * 86400000).toISOString(),
    singleEvents: true, // разворачивает серии в отдельные инстансы (свой id и colorId)
    orderBy: "startTime",
    maxResults: 2500,
  });
  const out: ColorOccurrence[] = [];
  for (const ev of res.data.items || []) {
    if (ev.status === "cancelled" || !ev.id) continue;
    if ((ev.extendedProperties?.private?.status || "pending") !== "confirmed") continue;
    const start = ev.start?.dateTime || ev.start?.date;
    if (!start) continue;
    // Часы блока: из extendedProperties.lessons (наследуется инстансом от мастера),
    // иначе оцениваем по длительности (60 мин = 1 час).
    const end = ev.end?.dateTime || ev.end?.date;
    const hours =
      Number(ev.extendedProperties?.private?.lessons) ||
      (end
        ? Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 3600000))
        : 1);
    out.push({ instanceId: ev.id, start: new Date(start), hours, colorId: ev.colorId ?? null });
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
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
  moved: boolean; // разовый перенос одного занятия серии (исключение-инстанс)
  origStart: string; // для moved — исходное время занятия до переноса (ISO), иначе ""
}

// Множество id «живых» (не отменённых) событий владельца ссылки — для сверки CRM
// с календарём (источник правды). Занятие в БД, чьё событие удалено/отменено —
// уже не активно. Берём широкое окно (±~13 мес), чтобы захватить и прошлые занятия.
export async function liveEventIdsForContact(key: string): Promise<Set<string>> {
  const cal = calendarClient();
  const now = Date.now();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: ["app=zapis", `contactKey=${key}`],
    timeMin: new Date(now - 400 * 86400000).toISOString(),
    timeMax: new Date(now + 400 * 86400000).toISOString(),
    singleEvents: false,
    maxResults: 250,
  });
  const ids = new Set<string>();
  for (const ev of res.data.items || []) {
    if (ev.status === "cancelled") continue;
    if (ev.id) ids.add(ev.id);
  }
  return ids;
}

// Ближайшее будущее занятие владельца ссылки (ISO начала) — конкретная дата, с учётом
// отменённых недель (EXDATE) и переносов. Разворачиваем все занятия в инстансы по времени
// и берём первый непрошедший. null — предстоящих занятий нет.
export async function nextOccurrenceForContact(key: string): Promise<string | null> {
  const cal = calendarClient();
  const now = new Date();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: ["app=zapis", `contactKey=${key}`],
    timeMin: now.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 30,
  });
  for (const i of res.data.items || []) {
    if (i.status === "cancelled") continue;
    // Только подтверждённые: неподтверждённая заявка/перенос — ещё не «ближайшее занятие».
    if ((i.extendedProperties?.private?.status || "pending") !== "confirmed") continue;
    const s = i.start?.dateTime || i.start?.date;
    if (!s || new Date(s).getTime() < now.getTime()) continue;
    return new Date(s).toISOString();
  }
  return null;
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
    const priv = ev.extendedProperties?.private || {};
    const moved = priv.moved === "1";
    // Инстансы-исключения повтора (напр. отдельно перекрашенный повтор) приходят
    // отдельными объектами с recurringEventId — сам слот уже представлен мастер-серией,
    // поэтому их пропускаем, иначе «Ваши записи» и подсчёт лимита дублируются.
    // Исключение — разовый перенос (moved): его показываем отдельной строкой «Перенос».
    if (ev.recurringEventId && !moved) continue;
    const start = ev.start?.dateTime || ev.start?.date;
    if (!ev.id || !start) continue;
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
      moved,
      origStart: moved && priv.origStart ? new Date(priv.origStart).toISOString() : "",
    });
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}
