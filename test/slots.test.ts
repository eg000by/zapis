import { describe, expect, it } from "vitest";
import {
  blockSpanMinutes,
  buildRecurrence,
  formatMskRange,
  shiftIntoWeekOf,
  validateSlot,
  weeklyOccurrences,
} from "@/lib/slots";

// Фиксированное «сейчас»: суббота 12 июля 2026, 12:00 МСК.
const NOW = new Date("2026-07-12T09:00:00.000Z");
// Вторник 14 июля 2026, 18:10 МСК — валидный слот сетки.
const TUE = "2026-07-14T15:10:00.000Z";

describe("blockSpanMinutes", () => {
  it("одно занятие = 60 минут, блок из N — с внутренними перерывами", () => {
    expect(blockSpanMinutes(1)).toBe(60);
    expect(blockSpanMinutes(2)).toBe(130); // 70 + 60
    expect(blockSpanMinutes(4)).toBe(270);
    expect(blockSpanMinutes(0)).toBe(60); // не меньше одного занятия
  });
});

describe("validateSlot", () => {
  it("принимает свободный слот сетки в будущем", () => {
    const v = validateSlot(TUE, [], NOW);
    expect(v.ok).toBe(true);
    expect(v.end?.toISOString()).toBe("2026-07-14T16:10:00.000Z");
  });

  it("отклоняет прошедшее время", () => {
    const v = validateSlot("2026-07-10T15:10:00.000Z", [], NOW);
    expect(v).toMatchObject({ ok: false, reason: "Это время уже прошло" });
  });

  it("отклоняет время вне сетки (не кратно шагу 70 минут)", () => {
    // 18:00 МСК — между стартами 17:00 и 18:10.
    const v = validateSlot("2026-07-14T15:00:00.000Z", [], NOW);
    expect(v).toMatchObject({ ok: false, reason: "Время вне сетки" });
  });

  it("отклоняет блок, не влезающий в рабочие часы", () => {
    // 18:10 + 2 занятия → конец 20:20, позже WORK_END_HOUR=20.
    const v = validateSlot(TUE, [], NOW, 2);
    expect(v).toMatchObject({ ok: false, reason: "Время вне рабочих часов" });
  });

  it("отклоняет пересечение с занятостью (по абсолютному моменту)", () => {
    const busy = [
      { start: new Date("2026-07-14T15:30:00.000Z"), end: new Date("2026-07-14T16:30:00.000Z") },
    ];
    expect(validateSlot(TUE, busy, NOW)).toMatchObject({ ok: false, reason: "Слот уже занят" });
  });

  it("занятость, касающаяся слота впритык, не мешает", () => {
    const busy = [
      { start: new Date("2026-07-14T16:10:00.000Z"), end: new Date("2026-07-14T17:10:00.000Z") },
    ];
    expect(validateSlot(TUE, busy, NOW).ok).toBe(true);
  });

  it("некорректная дата — отказ", () => {
    expect(validateSlot("мусор", [], NOW).ok).toBe(false);
  });
});

describe("weeklyOccurrences", () => {
  it("шаг ровно 7 суток, первое = сам слот", () => {
    expect(weeklyOccurrences(TUE, 3)).toEqual([
      "2026-07-14T15:10:00.000Z",
      "2026-07-21T15:10:00.000Z",
      "2026-07-28T15:10:00.000Z",
    ]);
  });

  it("weeks<=1 — одно наступление", () => {
    expect(weeklyOccurrences(TUE, 0)).toEqual([TUE]);
  });
});

describe("buildRecurrence", () => {
  it("weeks=1 — без правила повторения", () => {
    const r = buildRecurrence(TUE, 1, [], NOW);
    expect(r.ok).toBe(true);
    expect(r.recurrence).toBeUndefined();
  });

  it("серия: RRULE с COUNT", () => {
    const r = buildRecurrence(TUE, 26, [], NOW);
    expect(r.ok).toBe(true);
    expect(r.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=26"]);
  });

  it("занятая будущая неделя уходит в EXDATE (стеночное МСК), серия не падает", () => {
    const busy = [
      { start: new Date("2026-07-21T15:10:00.000Z"), end: new Date("2026-07-21T16:10:00.000Z") },
    ];
    const r = buildRecurrence(TUE, 4, busy, NOW);
    expect(r.ok).toBe(true);
    expect(r.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "EXDATE;TZID=Europe/Moscow:20260721T181000",
    ]);
  });

  it("занятое первое занятие валит всю серию", () => {
    const busy = [
      { start: new Date("2026-07-14T15:10:00.000Z"), end: new Date("2026-07-14T16:10:00.000Z") },
    ];
    expect(buildRecurrence(TUE, 4, busy, NOW).ok).toBe(false);
  });
});

describe("formatMskRange", () => {
  it("одно занятие — только время начала", () => {
    expect(formatMskRange(TUE)).toBe("Вт, 14 июля, 18:10 (МСК)");
  });

  it("блок — диапазон с концом последнего занятия", () => {
    expect(formatMskRange("2026-07-14T07:00:00.000Z", 2)).toBe(
      "Вт, 14 июля, 10:00–12:10 (МСК)"
    );
  });
});

describe("shiftIntoWeekOf (цель разового переноса)", () => {
  it("слот сетки уезжает в неделю переносимого занятия", () => {
    // Ближайший вторник — 14 июля; переносим занятие 28 июля.
    expect(shiftIntoWeekOf(TUE, "2026-07-28T15:10:00.000Z", NOW)).toBe(
      "2026-07-28T15:10:00.000Z"
    );
  });

  it("другой день недели попадает в ту же неделю занятия", () => {
    // Слот «среда 15 июля», занятие во вторник 28 июля → среда 29 июля.
    expect(
      shiftIntoWeekOf("2026-07-15T15:10:00.000Z", "2026-07-28T15:10:00.000Z", NOW)
    ).toBe("2026-07-29T15:10:00.000Z");
  });

  it("если после сдвига время в прошлом — берётся неделей позже", () => {
    // Занятие на прошлой неделе (7 июля) — сдвиг назад дал бы прошлое.
    expect(shiftIntoWeekOf(TUE, "2026-07-07T15:10:00.000Z", NOW)).toBe(TUE);
  });

  it("без сдвига, если слот уже в нужной неделе", () => {
    expect(shiftIntoWeekOf(TUE, "2026-07-14T07:00:00.000Z", NOW)).toBe(TUE);
  });
});
