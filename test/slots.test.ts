import { describe, expect, it } from "vitest";
import {
  blockSpanMinutes,
  buildRecurrence,
  buildWeek,
  formatMskRange,
  shiftIntoWeekOf,
  validateSlot,
  weeklyOccurrences,
} from "@/lib/slots";

// Фиксированное «сейчас»: суббота 12 июля 2026, 12:00 МСК.
const NOW = new Date("2026-07-12T09:00:00.000Z");
// Расписание: Вт/Чт/Сб 9–14, Пн/Ср 16–21, Пт/Вс недоступны.
// Вторник 14 июля 2026, 09:00 МСК — валидный слот сетки (06:00 UTC).
const TUE = "2026-07-14T06:00:00.000Z";

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
    expect(v.end?.toISOString()).toBe("2026-07-14T07:00:00.000Z");
  });

  it("отклоняет прошедшее время", () => {
    const v = validateSlot("2026-07-07T06:00:00.000Z", [], NOW);
    expect(v).toMatchObject({ ok: false, reason: "Это время уже прошло" });
  });

  it("отклоняет время вне сетки (не кратно шагу 70 минут)", () => {
    // 09:30 МСК — между стартами 09:00 и 10:10.
    const v = validateSlot("2026-07-14T06:30:00.000Z", [], NOW);
    expect(v).toMatchObject({ ok: false, reason: "Время вне сетки" });
  });

  it("отклоняет блок, не влезающий в рабочие часы дня", () => {
    // 12:30 МСК (последний слот Вт) + 2 занятия → конец 14:40, позже 14:00.
    const v = validateSlot("2026-07-14T09:30:00.000Z", [], NOW, 2);
    expect(v).toMatchObject({ ok: false, reason: "Время вне рабочих часов" });
  });

  it("недоступный день (пятница) отклоняется", () => {
    // Пятница 17 июля 2026, 09:00 МСК.
    const v = validateSlot("2026-07-17T06:00:00.000Z", [], NOW);
    expect(v).toMatchObject({ ok: false, reason: "Этот день недоступен" });
  });

  it("понедельник — окно 16–21: 16:00 валиден, 09:00 вне сетки", () => {
    // Пн 13 июля 16:00 МСК = 13:00 UTC.
    expect(validateSlot("2026-07-13T13:00:00.000Z", [], NOW).ok).toBe(true);
    // Пн 09:00 — до начала окна (16:00) → вне сетки.
    expect(validateSlot("2026-07-13T06:00:00.000Z", [], NOW)).toMatchObject({
      ok: false,
      reason: "Время вне сетки",
    });
  });

  it("отклоняет пересечение с занятостью (по абсолютному моменту)", () => {
    const busy = [
      { start: new Date("2026-07-14T06:30:00.000Z"), end: new Date("2026-07-14T07:30:00.000Z") },
    ];
    expect(validateSlot(TUE, busy, NOW)).toMatchObject({ ok: false, reason: "Слот уже занят" });
  });

  it("занятость, касающаяся слота впритык, не мешает", () => {
    const busy = [
      { start: new Date("2026-07-14T07:00:00.000Z"), end: new Date("2026-07-14T08:00:00.000Z") },
    ];
    expect(validateSlot(TUE, busy, NOW).ok).toBe(true);
  });

  it("некорректная дата — отказ", () => {
    expect(validateSlot("мусор", [], NOW).ok).toBe(false);
  });
});

describe("buildWeek — обезличенная неделя с окнами по дням", () => {
  it("доступны только Пн,Вт,Ср,Чт,Сб; у каждого своё окно", () => {
    const days = buildWeek([], NOW);
    expect(days.map((d) => d.weekday)).toEqual(["Пн", "Вт", "Ср", "Чт", "Сб"]);
    const byWd = Object.fromEntries(days.map((d) => [d.weekday, d]));
    // Вт 9–14: первый слот 09:00, последний 12:30.
    expect(byWd["Вт"].slots[0].time).toBe("09:00");
    expect(byWd["Вт"].slots.at(-1)!.time).toBe("12:30");
    // Пн 16–21: первый слот 16:00, последний 19:30.
    expect(byWd["Пн"].slots[0].time).toBe("16:00");
    expect(byWd["Пн"].slots.at(-1)!.time).toBe("19:30");
  });
});

describe("weeklyOccurrences", () => {
  it("шаг ровно 7 суток, первое = сам слот", () => {
    expect(weeklyOccurrences(TUE, 3)).toEqual([
      "2026-07-14T06:00:00.000Z",
      "2026-07-21T06:00:00.000Z",
      "2026-07-28T06:00:00.000Z",
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
      { start: new Date("2026-07-21T06:00:00.000Z"), end: new Date("2026-07-21T07:00:00.000Z") },
    ];
    const r = buildRecurrence(TUE, 4, busy, NOW);
    expect(r.ok).toBe(true);
    expect(r.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "EXDATE;TZID=Europe/Moscow:20260721T090000",
    ]);
  });

  it("занятое первое занятие валит всю серию", () => {
    const busy = [
      { start: new Date("2026-07-14T06:00:00.000Z"), end: new Date("2026-07-14T07:00:00.000Z") },
    ];
    expect(buildRecurrence(TUE, 4, busy, NOW).ok).toBe(false);
  });
});

describe("formatMskRange", () => {
  it("одно занятие — только время начала", () => {
    expect(formatMskRange(TUE)).toBe("Вт, 14 июля, 09:00 (МСК)");
  });

  it("блок — диапазон с концом последнего занятия", () => {
    expect(formatMskRange(TUE, 2)).toBe("Вт, 14 июля, 09:00–11:10 (МСК)");
  });
});

describe("shiftIntoWeekOf (цель разового переноса)", () => {
  it("слот сетки уезжает в неделю переносимого занятия", () => {
    // Ближайший вторник — 14 июля; переносим занятие 28 июля.
    expect(shiftIntoWeekOf(TUE, "2026-07-28T06:00:00.000Z", NOW)).toBe("2026-07-28T06:00:00.000Z");
  });

  it("другой день недели попадает в ту же неделю занятия", () => {
    // Слот «среда 15 июля 16:00», занятие во вторник 28 июля → среда 29 июля.
    expect(
      shiftIntoWeekOf("2026-07-15T13:00:00.000Z", "2026-07-28T06:00:00.000Z", NOW)
    ).toBe("2026-07-29T13:00:00.000Z");
  });

  it("если после сдвига время в прошлом — берётся неделей позже", () => {
    expect(shiftIntoWeekOf(TUE, "2026-07-07T06:00:00.000Z", NOW)).toBe(TUE);
  });

  it("без сдвига, если слот уже в нужной неделе", () => {
    expect(shiftIntoWeekOf(TUE, "2026-07-14T06:00:00.000Z", NOW)).toBe(TUE);
  });
});
