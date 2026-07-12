// Фейковый Google Calendar в памяти для тестов. Реализует подмножество API,
// которым пользуется приложение, с той же семантикой, что и настоящий:
//  - events.patch МЕРДЖИТ extendedProperties.private по ключам ("" остаётся ключом);
//  - list(singleEvents=true) разворачивает RRULE:FREQ=WEEKLY;COUNT=n с учётом EXDATE
//    и materialized-исключений (перенесённые инстансы имеют originalStartTime);
//  - instances(eventId) возвращает наступления серии в окне по ТЕКУЩЕМУ времени;
//  - patch/delete по id инстанса материализует исключение (delete ~ EXDATE);
//  - delete мастера удаляет серию целиком.
// Подключается через vi.mock("googleapis") — весь lib/google работает по-настоящему.

interface StoredEvent {
  id: string;
  summary?: string;
  description?: string;
  status: string; // confirmed | tentative | cancelled
  colorId?: string | null;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { dateTime: string };
  extendedProperties?: { private?: Record<string, string> };
}

const MSK_OFFSET_MS = 180 * 60000;
const WEEK_MS = 7 * 86400000;

let events = new Map<string, StoredEvent>();
let counter = 0;

export function resetCalendar(): void {
  events = new Map();
  counter = 0;
}

// Прямое заведение события в фейковый календарь (для подготовки сценария).
export function seedEvent(ev: Partial<StoredEvent> & { start: { dateTime: string } }): StoredEvent {
  const id = ev.id || `seed${++counter}`;
  const stored: StoredEvent = { status: "confirmed", ...ev, id } as StoredEvent;
  events.set(id, stored);
  return stored;
}

export function getStored(id: string): StoredEvent | undefined {
  return events.get(id);
}

export function allStored(): StoredEvent[] {
  return Array.from(events.values());
}

function isMaster(ev: StoredEvent): boolean {
  return Array.isArray(ev.recurrence) && ev.recurrence.length > 0;
}

function parseRule(ev: StoredEvent): { count: number; exdates: Set<number> } {
  let count = 1;
  const exdates = new Set<number>();
  for (const line of ev.recurrence || []) {
    const rr = line.match(/^RRULE:.*COUNT=(\d+)/);
    if (rr) count = Number(rr[1]);
    const ex = line.match(/^EXDATE(?:;TZID=[^:]+)?:(.+)$/);
    if (ex) {
      // Штампы «стеночного» МСК: 20260722T181000
      for (const stamp of ex[1].split(",")) {
        const m = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
        if (!m) continue;
        exdates.add(
          Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - MSK_OFFSET_MS
        );
      }
    }
  }
  return { count, exdates };
}

function utcStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

export function instanceIdFor(masterId: string, origIso: string): string {
  return `${masterId}_${utcStamp(new Date(origIso).getTime())}`;
}

// Materialized-исключения данной серии, по origStart (ms).
function exceptionsOf(masterId: string): Map<number, StoredEvent> {
  const out = new Map<number, StoredEvent>();
  for (const ev of events.values()) {
    if (ev.recurringEventId === masterId && ev.originalStartTime?.dateTime) {
      out.set(new Date(ev.originalStartTime.dateTime).getTime(), ev);
    }
  }
  return out;
}

// Эффективные private-свойства: исключение наследует ключи мастера
// (Google копирует их при материализации), свои — поверх.
function effectivePrivate(ev: StoredEvent): Record<string, string> {
  const own = ev.extendedProperties?.private || {};
  if (!ev.recurringEventId) return { ...own };
  const master = events.get(ev.recurringEventId);
  return { ...(master?.extendedProperties?.private || {}), ...own };
}

interface InstanceItem extends StoredEvent {
  recurringEventId: string;
  originalStartTime: { dateTime: string };
}

// Все занятия серии: нетронутые наступления + materialized-исключения.
function expand(master: StoredEvent): InstanceItem[] {
  const startMs = new Date(master.start!.dateTime!).getTime();
  const durMs = master.end?.dateTime
    ? new Date(master.end.dateTime).getTime() - startMs
    : 3600000;
  const { count, exdates } = parseRule(master);
  const exc = exceptionsOf(master.id);
  const out: InstanceItem[] = [];
  for (let w = 0; w < count; w++) {
    const occMs = startMs + w * WEEK_MS;
    if (exdates.has(occMs)) continue;
    const override = exc.get(occMs);
    if (override) {
      if (override.status === "cancelled") continue;
      out.push({
        ...override,
        extendedProperties: { private: effectivePrivate(override) },
      } as InstanceItem);
      continue;
    }
    out.push({
      id: instanceIdFor(master.id, new Date(occMs).toISOString()),
      summary: master.summary,
      status: master.status,
      colorId: master.colorId,
      start: { dateTime: new Date(occMs).toISOString() },
      end: { dateTime: new Date(occMs + durMs).toISOString() },
      recurringEventId: master.id,
      originalStartTime: { dateTime: new Date(occMs).toISOString() },
      extendedProperties: { private: effectivePrivate(master) },
    });
  }
  return out;
}

// id инстанса "<masterId>_<stamp>Z" → { master, origMs }, если серия существует.
function parseInstanceId(id: string): { master: StoredEvent; origMs: number } | null {
  const idx = id.lastIndexOf("_");
  if (idx < 0) return null;
  const master = events.get(id.slice(0, idx));
  if (!master || !isMaster(master)) return null;
  const m = id
    .slice(idx + 1)
    .match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return {
    master,
    origMs: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
  };
}

// Виртуальный (ещё не materialized) инстанс по id — как его вернул бы get().
function synthesizeInstance(id: string): StoredEvent | null {
  const parsed = parseInstanceId(id);
  if (!parsed) return null;
  const inst = expand(parsed.master).find(
    (i) => new Date(i.originalStartTime.dateTime).getTime() === parsed.origMs
  );
  return inst || null;
}

function notFound(): never {
  const err: any = new Error("Not Found");
  err.code = 404;
  throw err;
}

function inWindow(ev: StoredEvent, timeMin?: string, timeMax?: string): boolean {
  const s = ev.start?.dateTime ? new Date(ev.start.dateTime).getTime() : 0;
  const e = ev.end?.dateTime ? new Date(ev.end.dateTime).getTime() : s;
  if (timeMin && e <= new Date(timeMin).getTime()) return false;
  if (timeMax && s >= new Date(timeMax).getTime()) return false;
  return true;
}

function matchesPrivateFilter(ev: StoredEvent, filters?: string[]): boolean {
  if (!filters || filters.length === 0) return true;
  const priv = effectivePrivate(ev);
  return filters.every((f) => {
    const i = f.indexOf("=");
    return priv[f.slice(0, i)] === f.slice(i + 1);
  });
}

export const fakeCalendar = {
  events: {
    async insert({ requestBody }: any) {
      const id = `ev${++counter}`;
      const stored: StoredEvent = {
        status: "confirmed",
        ...structuredClone(requestBody),
        id,
      };
      events.set(id, stored);
      return { data: structuredClone(stored) };
    },

    async get({ eventId }: any) {
      const ev = events.get(eventId) || synthesizeInstance(eventId);
      if (!ev || ev.status === "cancelled") {
        if (!ev) notFound();
      }
      return { data: structuredClone(ev) };
    },

    async patch({ eventId, requestBody }: any) {
      let ev = events.get(eventId);
      if (!ev) {
        // Патч виртуального инстанса материализует исключение серии.
        const inst = synthesizeInstance(eventId);
        if (!inst) notFound();
        ev = structuredClone(inst);
        events.set(eventId, ev);
      }
      const body = structuredClone(requestBody);
      for (const k of ["summary", "description", "status", "recurrence"] as const) {
        if (k in body) (ev as any)[k] = body[k];
      }
      if ("colorId" in body) ev.colorId = body.colorId; // null снимает цвет
      if (body.start) ev.start = body.start;
      if (body.end) ev.end = body.end;
      if (body.extendedProperties?.private) {
        // Семантика Google: merge по ключам; "" НЕ удаляет ключ, а хранит пустую строку.
        ev.extendedProperties = ev.extendedProperties || {};
        ev.extendedProperties.private = {
          ...(ev.extendedProperties.private || {}),
          ...body.extendedProperties.private,
        };
      }
      return { data: structuredClone(ev) };
    },

    async delete({ eventId }: any) {
      const ev = events.get(eventId);
      if (ev) {
        if (isMaster(ev)) {
          // Удаление мастера сносит серию вместе с исключениями.
          for (const [id, e] of events) {
            if (e.recurringEventId === eventId) events.delete(id);
          }
          events.delete(eventId);
        } else {
          ev.status = "cancelled";
        }
        return { data: {} };
      }
      // Удаление виртуального инстанса = отмена наступления (EXDATE-подобно).
      const inst = synthesizeInstance(eventId);
      if (!inst) notFound();
      const cancelled = structuredClone(inst);
      cancelled.status = "cancelled";
      events.set(eventId, cancelled);
      return { data: {} };
    },

    async list(params: any) {
      const {
        timeMin,
        timeMax,
        singleEvents,
        orderBy,
        maxResults,
        privateExtendedProperty,
      } = params;
      let items: StoredEvent[] = [];
      for (const ev of events.values()) {
        if (ev.status === "cancelled") continue;
        if (isMaster(ev)) {
          if (singleEvents) {
            items.push(...expand(ev));
          } else {
            // Мастер попадает в выдачу, если хоть одно наступление в окне.
            if (expand(ev).some((i) => inWindow(i, timeMin, timeMax))) items.push(ev);
          }
        } else if (!ev.recurringEventId) {
          items.push(ev);
        } else if (!singleEvents) {
          // singleEvents=false: materialized-исключения приходят отдельными строками.
          items.push({ ...ev, extendedProperties: { private: effectivePrivate(ev) } });
        }
        // singleEvents=true: исключения уже включены через expand().
      }
      items = items.filter(
        (ev) =>
          ev.status !== "cancelled" &&
          (isMaster(ev) || inWindow(ev, timeMin, timeMax)) &&
          matchesPrivateFilter(ev, privateExtendedProperty)
      );
      if (orderBy === "startTime") {
        items.sort(
          (a, b) =>
            new Date(a.start?.dateTime || 0).getTime() -
            new Date(b.start?.dateTime || 0).getTime()
        );
      }
      if (maxResults) items = items.slice(0, maxResults);
      return { data: { items: structuredClone(items) } };
    },

    async instances({ eventId, timeMin, timeMax, maxResults }: any) {
      const master = events.get(eventId);
      if (!master || !isMaster(master)) notFound();
      // Окно фильтрует по ТЕКУЩЕМУ времени инстанса (перенесённый инстанс «уезжает»
      // из окна своего исходного времени) — как в реальном API.
      let items = expand(master!).filter((i) => inWindow(i, timeMin, timeMax));
      if (maxResults) items = items.slice(0, maxResults);
      return { data: { items: structuredClone(items) } };
    },
  },
};

export const google = {
  auth: {
    OAuth2: class {
      constructor(..._args: any[]) {}
      setCredentials(_creds: any) {}
    },
  },
  calendar: (_opts: any) => fakeCalendar,
};
