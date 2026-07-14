// deleteFutureEventsForContact: удаление будущих непроведённых занятий из календаря
// при удалении ученика. Работает поверх фейкового Google Calendar (helpers/fake-google).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allStored, getStored, resetCalendar, seedEvent } from "./helpers/fake-google";

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
