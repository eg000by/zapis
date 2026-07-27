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

// Описание занятия в календаре — единый шаблон для заявки (ожидает подтверждения),
// подтверждения из бота и обновления ссылки на Телемост. Один текст в одном месте,
// иначе поверхности расходятся (и «Телемост:» надо чинить в двух шаблонах сразу).
export function lessonDescription(opts: {
  student: string;
  subject: string;
  recurring: boolean;
  confirmed: boolean;
  trial?: boolean;
  tg?: string;
  meetLink?: string;
}): string {
  const single = opts.trial ? "Пробное занятие (разовое)\n" : "Разовое занятие\n";
  return (
    (opts.confirmed
      ? `Занятие подтверждено.\n`
      : `Заявка через сайт записи (ожидает подтверждения).\n`) +
    `Ученик: ${opts.student}\n` +
    `Предмет: ${opts.subject}\n` +
    (opts.recurring ? `Повтор: еженедельно\n` : single) +
    (opts.tg ? `Telegram: ${opts.tg}\n` : "") +
    (opts.meetLink ? `Телемост: ${opts.meetLink}\n` : "")
  );
}

// Повторяющееся ли занятие. У мастера серии есть recurrence, а у инстанса-исключения
// (разовый перенос одной недели) — только recurringEventId, поэтому проверяем оба.
export function isRecurringEvent(ev: {
  recurrence?: string[] | null;
  recurringEventId?: string | null;
}): boolean {
  return !!ev.recurringEventId || (Array.isArray(ev.recurrence) && ev.recurrence.length > 0);
}

// Перестраивает строку «Телемост: …» в описании события: убирает старую (если была)
// и добавляет новую, когда ссылка задана. Хвостовые пустые строки подчищаем.
// Запасной путь для старых событий, у которых в extendedProperties нет данных
// для полной пересборки описания.
function withMeetLink(description: string, meetLink: string): string {
  const lines = (description || "")
    .split("\n")
    .filter((l) => !/^\s*телемост\s*:/i.test(l));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (meetLink) lines.push(`Телемост: ${meetLink}`);
  return lines.join("\n");
}

// Обновляет ссылку на Телемост в описании всех подтверждённых событий ученика
// (серии — по мастеру, одиночные — сами). Вызывается при добавлении/смене ссылки
// в кабинете, чтобы она появилась в уже существующих событиях календаря.
//
// Описание пересобирается целиком: у событий, подтверждённых до появления этого
// кода, в теле осталось «Заявка … (ожидает подтверждения)» — дописать под ним
// Телемост и оставить неверную шапку нельзя. Патчи идут параллельно: вызывается
// из формы /admin и из вебхука Telegram, последовательные round-trip'ы к календарю
// задерживали бы ответ.
export async function applyMeetLinkToEvents(key: string, meetLink: string): Promise<number> {
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
  const patched = await Promise.all(
    (res.data.items || []).map(async (ev) => {
      if (ev.status === "cancelled" || !ev.id) return 0;
      const priv = ev.extendedProperties?.private || {};
      if ((priv.status || "pending") !== "confirmed") return 0;
      // Есть данные ученика в событии — пересобираем описание целиком; нет (совсем
      // старое событие) — правим только строку «Телемост:».
      const next =
        priv.student && priv.subject
          ? lessonDescription({
              student: priv.student,
              subject: priv.subject,
              recurring: isRecurringEvent(ev),
              confirmed: true,
              tg: priv.tg,
              meetLink,
            })
          : withMeetLink(ev.description || "", meetLink);
      if (next === (ev.description || "")) return 0;
      try {
        await cal.events.patch({
          calendarId: CALENDAR_ID,
          eventId: ev.id,
          requestBody: { description: next },
        });
        return 1;
      } catch (e) {
        console.error("applyMeetLinkToEvents patch failed", ev.id, e);
        return 0;
      }
    })
  );
  return patched.reduce<number>((sum, n) => sum + n, 0);
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

// Мастер-событие повторяющейся серии (по всем ученикам) — для проверки, что серия
// скоро закончится (RRULE с COUNT/UNTIL) и её пора продлевать.
export interface SeriesMaster {
  id: string;
  student: string;
  studentId: string;
  subject: string;
  start: Date;
  rrule: string;
  finite: boolean; // есть COUNT/UNTIL — серия конечна и когда-нибудь оборвётся
}

export async function listSeriesMasters(): Promise<SeriesMaster[]> {
  const cal = calendarClient();
  const now = Date.now();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: ["app=zapis"],
    timeMin: new Date(now - 400 * 86400000).toISOString(),
    timeMax: new Date(now + 400 * 86400000).toISOString(),
    singleEvents: false,
    maxResults: 250,
  });
  const out: SeriesMaster[] = [];
  for (const ev of res.data.items || []) {
    if (ev.status === "cancelled" || !ev.id) continue;
    const priv = ev.extendedProperties?.private || {};
    if ((priv.status || "pending") !== "confirmed") continue;
    const rrule = (ev.recurrence || []).find((r) => /^RRULE:/i.test(r));
    if (!rrule) continue;
    const start = ev.start?.dateTime || ev.start?.date;
    if (!start) continue;
    out.push({
      id: ev.id,
      student: priv.student || "",
      studentId: priv.studentId || "",
      subject: priv.subject || "",
      start: new Date(start),
      rrule,
      finite: /(^|;)(COUNT|UNTIL)=/i.test(rrule),
    });
  }
  return out;
}

// Одно занятие за конкретный день — для утреннего отчёта и напоминаний.
export interface DayOccurrence {
  instanceId: string;
  start: Date;
  hours: number;
  colorId: string | null;
  student: string;
  subject: string;
  studentId: string;
  contactKey: string;
}

// Все ПОДТВЕРЖДЁННЫЕ занятия сервиса (по всем ученикам) за окно [timeMin, timeMax),
// развёрнутые в инстансы. Для утреннего отчёта «занятия за вчера» и напоминаний.
export async function listDayOccurrences(timeMin: Date, timeMax: Date): Promise<DayOccurrence[]> {
  const cal = calendarClient();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: ["app=zapis"],
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });
  const out: DayOccurrence[] = [];
  for (const ev of res.data.items || []) {
    if (ev.status === "cancelled" || !ev.id) continue;
    const priv = ev.extendedProperties?.private || {};
    if ((priv.status || "pending") !== "confirmed") continue;
    const start = ev.start?.dateTime || ev.start?.date;
    if (!start) continue;
    const end = ev.end?.dateTime || ev.end?.date;
    const hours =
      Number(priv.lessons) ||
      (end
        ? Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 3600000))
        : 1);
    out.push({
      instanceId: ev.id,
      start: new Date(start),
      hours,
      colorId: ev.colorId ?? null,
      student: priv.student || priv.name || "",
      subject: priv.subject || "",
      studentId: priv.studentId || "",
      contactKey: priv.contactKey || "",
    });
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

// Момент в формате RRULE UNTIL (UTC): "20260714T090000Z".
function utcRuleStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// Разбирает момент RRULE (UNTIL): "20260714T090000Z" или "20260714". null — не распознан.
function parseRuleStamp(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(stamp.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  return new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh || 0), Number(mi || 0), Number(ss || 0))
  );
}

// Продлевает правило повтора на weeks недель: COUNT=N → COUNT=N+weeks (для FREQ=WEEKLY
// одно наступление = одна неделя), UNTIL=дата → дата+weeks недель. Бесконечное правило
// (ни COUNT, ни UNTIL) продлевать нечего — возвращаем null.
export function extendRrule(rrule: string, weeks: number): string | null {
  let changed = false;
  const parts = rrule
    .replace(/^RRULE:/i, "")
    .split(";")
    .filter(Boolean)
    .map((p) => {
      const count = /^COUNT=(\d+)$/i.exec(p);
      if (count) {
        changed = true;
        return `COUNT=${Number(count[1]) + weeks}`;
      }
      const until = /^UNTIL=(.+)$/i.exec(p);
      if (until) {
        const at = parseRuleStamp(until[1]);
        if (!at) return p;
        changed = true;
        return `UNTIL=${utcRuleStamp(new Date(at.getTime() + weeks * 7 * 86400000))}`;
      }
      return p;
    });
  return changed ? `RRULE:${parts.join(";")}` : null;
}

// Продлевает серию занятий на weeks недель. Возвращает ISO последнего наступления
// после продления (null — событие не найдено, это не серия или правило бесконечное).
export async function extendSeries(eventId: string, weeks: number): Promise<string | null> {
  const cal = calendarClient();
  const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId });
  const ev = res.data;
  if (!Array.isArray(ev.recurrence) || !ev.recurrence.length) return null;
  let touched = false;
  const recurrence = ev.recurrence.map((r) => {
    if (!/^RRULE:/i.test(r)) return r;
    const next = extendRrule(r, weeks);
    if (!next) return r;
    touched = true;
    return next;
  });
  if (!touched) return null;
  await cal.events.patch({ calendarId: CALENDAR_ID, eventId, requestBody: { recurrence } });
  return lastOccurrenceOf(eventId, new Date());
}

// ISO последнего будущего наступления серии (null — будущих наступлений нет).
export async function lastOccurrenceOf(eventId: string, from: Date): Promise<string | null> {
  const cal = calendarClient();
  const res = await cal.events.instances({
    calendarId: CALENDAR_ID,
    eventId,
    timeMin: from.toISOString(),
    maxResults: 250,
  });
  const starts = (res.data.items || [])
    .filter((i) => i.status !== "cancelled")
    .map((i) => i.start?.dateTime || i.start?.date || "")
    .filter(Boolean)
    .sort();
  return starts.length ? new Date(starts[starts.length - 1]).toISOString() : null;
}

// Обрезает RRULE до момента stamp: убирает COUNT/UNTIL и ставит UNTIL=stamp
// (будущие наступления после stamp пропадают, прошлые остаются).
function truncateRrule(rrule: string, stamp: string): string {
  const parts = rrule
    .replace(/^RRULE:/i, "")
    .split(";")
    .filter((p) => p && !/^(COUNT|UNTIL)=/i.test(p));
  parts.push(`UNTIL=${stamp}`);
  return `RRULE:${parts.join(";")}`;
}

// Удаляет все БУДУЩИЕ непроведённые занятия ученика из календаря (при удалении ученика):
// одиночные будущие события — целиком; серии, начавшиеся в прошлом, — обрезает по
// UNTIL=сейчас (прошлые занятия-история остаются); серии целиком в будущем — целиком.
// Возвращает число затронутых мастер-событий.
export async function deleteFutureEventsForContact(key: string): Promise<number> {
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
  let affected = 0;
  for (const ev of res.data.items || []) {
    if (ev.status === "cancelled" || !ev.id) continue;
    const startIso = ev.start?.dateTime || ev.start?.date;
    if (!startIso) continue;
    const isSeries = Array.isArray(ev.recurrence) && ev.recurrence.length > 0;
    const startMs = new Date(startIso).getTime();
    try {
      if (!isSeries) {
        if (startMs > now) {
          await cal.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id });
          affected++;
        }
        continue;
      }
      if (startMs > now) {
        // Вся серия ещё впереди — удаляем целиком.
        await cal.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id });
        affected++;
        continue;
      }
      // Серия уже идёт: обрезаем будущие наступления, прошлые оставляем.
      const stamp = utcRuleStamp(new Date(now));
      const recurrence = (ev.recurrence || []).map((r) =>
        /^RRULE:/i.test(r) ? truncateRrule(r, stamp) : r
      );
      await cal.events.patch({ calendarId: CALENDAR_ID, eventId: ev.id, requestBody: { recurrence } });
      affected++;
    } catch (e) {
      console.error("deleteFutureEventsForContact failed", ev.id, e);
    }
  }
  return affected;
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
