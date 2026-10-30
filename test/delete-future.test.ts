// deleteFutureEventsForContact: удаление будущих непроведённых занятий из календаря
// при удалении ученика. Работает поверх фейкового Google Calendar (helpers/fake-google).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allStored, getStored, instanceIdFor, resetCalendar, seedEvent } from "./helpers/fake-google";

vi.mock("googleapis", async () => {
  const { google } = await import("./helpers/fake-google");
  return { google, calendar_v3: {} };
});

const KEY = "contact-key-1";
const NOW = new Date("2026-07-12T09:00:00.000Z"); // Сб 12 июля, 12:00 МСК

function seed(over: Record<string, any>) {
  return seedEvent({
    summary: "Ученик — Предмет",
    extendedProperties: { private: { app: "zapis", contactKey: KEY, status: "confirmed" } },
    ...over,
  } as any);
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  resetCalendar();
});

describe("deleteFutureEventsForContact", () => {
  it("будущее одиночное — удаляет; прошедшее одиночное — оставляет", async () => {
    const { deleteFutureEventsForContact } = await import("@/lib/google");
    const future = seed({
      start: { dateTime: "2026-07-20T06:00:00.000Z" },
      end: { dateTime: "2026-07-20T07:00:00.000Z" },
    });
    const past = seed({
      start: { dateTime: "2026-07-05T06:00:00.000Z" },
      end: { dateTime: "2026-07-05T07:00:00.000Z" },
    });

    const n = await deleteFutureEventsForContact(KEY);
    expect(n).toBe(1);
    // Фейк помечает одиночное удаление статусом cancelled (реальный API удаляет строку).
    expect(getStored(future.id)?.status).toBe("cancelled");
    expect(getStored(past.id)?.status).not.toBe("cancelled");
  });

  it("серия целиком в будущем — удаляется целиком", async () => {
    const { deleteFutureEventsForContact } = await import("@/lib/google");
    const series = seed({
      start: { dateTime: "2026-08-03T06:00:00.000Z" },
      end: { dateTime: "2026-08-03T07:00:00.000Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=5"],
    });
    await deleteFutureEventsForContact(KEY);
    expect(getStored(series.id)).toBeUndefined();
  });

  it("серия, начавшаяся в прошлом — обрезается по UNTIL, событие остаётся", async () => {
    const { deleteFutureEventsForContact } = await import("@/lib/google");
    const series = seed({
      start: { dateTime: "2026-06-30T06:00:00.000Z" }, // началась 2 недели назад
      end: { dateTime: "2026-06-30T07:00:00.000Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=26"],
    });
    await deleteFutureEventsForContact(KEY);

    const ev = getStored(series.id)!;
    expect(ev).toBeDefined();
    const rrule = (ev.recurrence || []).find((r) => r.startsWith("RRULE"))!;
    expect(rrule).toContain("UNTIL=20260712T090000Z");
    expect(rrule).not.toContain("COUNT");
  });

  it("уже закончившуюся серию не продлевает (старое расписание не оживает)", async () => {
    const { deleteFutureEventsForContact } = await import("@/lib/google");
    // Серия закончилась 23 июня (расписание переехало), а «сейчас» — 12 июля.
    const ended = seed({
      start: { dateTime: "2026-06-02T06:00:00.000Z" },
      end: { dateTime: "2026-06-02T07:00:00.000Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20260624T000000Z"],
    });
    const endedByCount = seed({
      start: { dateTime: "2026-06-03T06:00:00.000Z" },
      end: { dateTime: "2026-06-03T07:00:00.000Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    });
    const n = await deleteFutureEventsForContact(KEY);
    expect(n).toBe(0);
    expect(getStored(ended.id)?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20260624T000000Z"]);
    expect(getStored(endedByCount.id)?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=3"]);
  });

  it("truncateSeriesAt: закончившуюся серию не трогает", async () => {
    const { truncateSeriesAt } = await import("@/lib/google");
    const ended = seed({
      start: { dateTime: "2026-06-02T06:00:00.000Z" },
      end: { dateTime: "2026-06-02T07:00:00.000Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20260624T000000Z"],
    });
    expect(await truncateSeriesAt(ended.id, NOW)).toBe(false);
    expect(getStored(ended.id)?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20260624T000000Z"]);
  });

  it("отменённое раньше занятие при архиве не оживает (Google теряет отмены при смене правила)", async () => {
    const { deleteFutureEventsForContact, calendarClient, CALENDAR_ID } = await import("@/lib/google");
    const series = seed({
      start: { dateTime: "2026-06-23T06:00:00.000Z" },
      end: { dateTime: "2026-06-23T07:00:00.000Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=26"],
    });
    // 30 июня занятие отменили (удалили одно наступление).
    const cancelled = instanceIdFor(series.id, "2026-06-30T06:00:00.000Z");
    await calendarClient().events.delete({ calendarId: CALENDAR_ID, eventId: cancelled });

    await deleteFutureEventsForContact(KEY);

    const list = await calendarClient().events.list({
      calendarId: CALENDAR_ID,
      singleEvents: true,
      timeMin: "2026-06-01T00:00:00.000Z",
      timeMax: "2026-08-01T00:00:00.000Z",
    });
    const starts = (list.data.items || []).map((i) => i.start?.dateTime);
    expect(starts).toEqual(["2026-06-23T06:00:00.000Z", "2026-07-07T06:00:00.000Z"]);
    expect(getStored(series.id)?.recurrence).toContain("EXDATE;TZID=Europe/Moscow:20260630T090000");
  });

  it("продление серии тоже не оживляет отменённое занятие", async () => {
    const { extendSeries, calendarClient, CALENDAR_ID } = await import("@/lib/google");
    const series = seed({
      start: { dateTime: "2026-07-07T06:00:00.000Z" },
      end: { dateTime: "2026-07-07T07:00:00.000Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    });
    await calendarClient().events.delete({
      calendarId: CALENDAR_ID,
      eventId: instanceIdFor(series.id, "2026-07-14T06:00:00.000Z"),
    });
    await extendSeries(series.id, 2);
    const list = await calendarClient().events.instances({ calendarId: CALENDAR_ID, eventId: series.id });
    const starts = (list.data.items || []).map((i) => i.start?.dateTime);
    expect(starts).not.toContain("2026-07-14T06:00:00.000Z");
    expect(starts).toHaveLength(4); // 5 недель минус отменённая
  });

  it("чужие события (другой contactKey / не наши) не трогает", async () => {
    const { deleteFutureEventsForContact } = await import("@/lib/google");
    const foreign = seed({
      start: { dateTime: "2026-07-20T06:00:00.000Z" },
      end: { dateTime: "2026-07-20T07:00:00.000Z" },
      extendedProperties: { private: { app: "zapis", contactKey: "другой", status: "confirmed" } },
    });
    const n = await deleteFutureEventsForContact(KEY);
    expect(n).toBe(0);
    expect(getStored(foreign.id)?.status).not.toBe("cancelled");
    expect(allStored()).toHaveLength(1);
  });
});

// Сброс цвета перед перекраской касается только мастеров серий. Раньше в него
// попадали исключения (каждое покрашенное занятие) и одиночные события: каждый
// пересчёт стирал всю раскраску и рисовал её заново — десятки запросов к Google,
// бот не успевал ответить, и цвета в календаре мигали.
describe("listContactMasters", () => {
  it("возвращает только мастера серий: без исключений и одиночных событий", async () => {
    const { listContactMasters, setEventColor } = await import("@/lib/google");
    const master = seed({
      start: { dateTime: "2026-07-01T06:00:00.000Z" },
      end: { dateTime: "2026-07-01T07:00:00.000Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=6"],
    });
    seed({
      start: { dateTime: "2026-07-03T06:00:00.000Z" },
      end: { dateTime: "2026-07-03T07:00:00.000Z" },
      colorId: "10",
    });
    // Покрашенный прошедший повтор — materialized-исключение серии.
    await setEventColor(instanceIdFor(master.id, "2026-07-01T06:00:00.000Z"), "10");

    const got = await listContactMasters(KEY);
    expect(got.map((m) => m.id)).toEqual([master.id]);
  });
});
