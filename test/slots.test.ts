import { describe, expect, it } from "vitest";
import {
  blockSpanMinutes,
  buildRecurrence,
  buildWeek,
  formatMskRange,
  shiftIntoWeekOf,
  validateSlot,
  weekWindowBounds,
  weeklyOccurrences,
} from "@/lib/slots";

// Фиксированное «сейчас»: суббота 12 июля 2026, 12:00 МСК.
const NOW = new Date("2026-07-12T09:00:00.000Z");
// Расписание: Вт/Чт/Сб 9–17, Пн/Ср 15–21, Пт/Вс — выходные (видны, но без слотов).
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
    // 16:00 МСК (последний слот Вт) + 2 занятия → конец 18:10, позже 17:00.
    const v = validateSlot("2026-07-14T13:00:00.000Z", [], NOW, 2);
    expect(v).toMatchObject({ ok: false, reason: "Время вне рабочих часов" });
  });

  it("недоступный день (пятница) отклоняется", () => {
    // Пятница 17 июля 2026, 09:00 МСК.
    const v = validateSlot("2026-07-17T06:00:00.000Z", [], NOW);
    expect(v).toMatchObject({ ok: false, reason: "Этот день недоступен" });
  });

  it("понедельник — окно 15–21: 15:00 валиден, 09:00 вне сетки", () => {
    // Пн 13 июля 15:00 МСК = 12:00 UTC.
    expect(validateSlot("2026-07-13T12:00:00.000Z", [], NOW).ok).toBe(true);
    // Пн 09:00 — до начала окна (15:00) → вне сетки.
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
  it("неделя показывается целиком; Пт и Вс — выходные (без слотов)", () => {
    const days = buildWeek([], NOW);
    expect(days.map((d) => d.weekday)).toEqual(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);
    const byWd = Object.fromEntries(days.map((d) => [d.weekday, d]));

    // Выходные: в сетке есть, слотов нет.
    for (const wd of ["Пт", "Вс"]) {
      expect(byWd[wd].closed).toBe(true);
      expect(byWd[wd].slots).toHaveLength(0);
    }

    // Вт 9–17: 09:00 … 16:00 (последний урок кончается ровно в 17:00).
    expect(byWd["Вт"].closed).toBe(false);
    expect(byWd["Вт"].slots[0].time).toBe("09:00");
    expect(byWd["Вт"].slots.at(-1)!.time).toBe("16:00");
    // Пн 15–21: 15:00 … 19:40.
    expect(byWd["Пн"].slots[0].time).toBe("15:00");
    expect(byWd["Пн"].slots.at(-1)!.time).toBe("19:40");
  });

  // Слот занят СО СЛЕДУЮЩЕЙ недели (чужая серия), а ближайшее наступление свободно.
  // Для еженедельной записи такой слот предлагать нельзя — время закрепляется
  // надолго. Для разовой (пробное занятие) он обязан быть доступен: занятие одно.
  it("занятость следующих недель закрывает слот только для еженедельной записи", () => {
    const busy = [
      // Вт 21 июля, 09:00 МСК — через неделю после ближайшего наступления.
      { start: new Date("2026-07-21T06:00:00.000Z"), end: new Date("2026-07-21T07:00:00.000Z") },
    ];
    const slotOf = (days: ReturnType<typeof buildWeek>) =>
      days.find((d) => d.weekday === "Вт")!.slots.find((s) => s.time === "09:00")!;

    expect(slotOf(buildWeek(busy, NOW)).busy).toBe(true);
    const once = slotOf(buildWeek(busy, NOW, { weeks: 1 }));
    expect(once.busy).toBe(false);
    expect(once.start).toBe(TUE); // именно ближайший вторник, а не следующий

    // Занятость самого ближайшего наступления закрывает слот в обоих режимах.
    const near = [
      { start: new Date("2026-07-14T06:00:00.000Z"), end: new Date("2026-07-14T07:00:00.000Z") },
    ];
    expect(slotOf(buildWeek(near, NOW, { weeks: 1 })).busy).toBe(true);
  });

  // Разовый перенос двигает ОДНО занятие: сетка строится на его неделю, и занятость
  // проверяется только на ту дату. Раньше сетка была общей, и слот, свободный в
  // нужную неделю, выглядел занятым из-за соседних недель — перенести было некуда.
  describe("разовый перенос (occIso)", () => {
    const OCC = "2026-07-28T06:00:00.000Z"; // переносим занятие Вт 28 июля
    const slotOf = (days: ReturnType<typeof buildWeek>, wd: string, time: string) =>
      days.find((d) => d.weekday === wd)!.slots.find((s) => s.time === time)!;

    it("слоты стоят на датах недели переносимого занятия", () => {
      const days = buildWeek([], NOW, { occIso: OCC });
      expect(slotOf(days, "Вт", "09:00").start).toBe(OCC);
      // Среда той же недели — 29 июля, 15:00 МСК (окно Ср 15–21).
      expect(slotOf(days, "Ср", "15:00").start).toBe("2026-07-29T12:00:00.000Z");
    });

    it("занятость соседних недель слот не закрывает, своей — закрывает", () => {
      const other = [
        // Тот же час, но за неделю до и через неделю после целевой даты.
        { start: new Date("2026-07-21T06:00:00.000Z"), end: new Date("2026-07-21T07:00:00.000Z") },
        { start: new Date("2026-08-04T06:00:00.000Z"), end: new Date("2026-08-04T07:00:00.000Z") },
      ];
      expect(slotOf(buildWeek(other, NOW, { occIso: OCC }), "Вт", "09:00").busy).toBe(false);

      const own = [{ start: new Date(OCC), end: new Date("2026-07-28T07:00:00.000Z") }];
      expect(slotOf(buildWeek(own, NOW, { occIso: OCC }), "Вт", "09:00").busy).toBe(true);
    });

    it("окно запроса к календарю дотягивается до недели занятия", () => {
      const { timeMin, timeMax } = weekWindowBounds(NOW, { occIso: OCC });
      expect(timeMin).toBe(NOW);
      // Иначе занятость целевой недели не попала бы в ответ Google и все слоты
      // этой недели выглядели бы свободными.
      expect(timeMax.getTime()).toBeGreaterThan(new Date(OCC).getTime() + 7 * 86400000);
    });
  });

  // «Другая дата»: сетка переезжает на выбранную КАЛЕНДАРНУЮ неделю целиком.
  // Это не то же самое, что occIso (там — наступления рядом с датой): ученик
  // видит недельную сетку Пн–Вс и должен получить ровно ту неделю, что выбрал.
  describe("выбранная неделя (fromIso)", () => {
    // Полдень среды 26 августа 2026 — этим моментом клиент обозначает выбранную дату.
    const FROM = "2026-08-26T09:00:00.000Z";
    const dayOf = (days: ReturnType<typeof buildWeek>, wd: string) =>
      days.find((d) => d.weekday === wd)!;

    it("вся неделя Пн–Вс выбранной даты, а не «плюс-минус полнедели»", () => {
      const days = buildWeek([], NOW, { fromIso: FROM });
      // Пн 24 августа … Вс 30 августа: воскресенье именно ПОСЛЕ среды.
      expect(dayOf(days, "Пн").slots[0].start).toBe("2026-08-24T12:00:00.000Z"); // 15:00 МСК
      expect(dayOf(days, "Ср").slots[0].start).toBe("2026-08-26T12:00:00.000Z");
      expect(dayOf(days, "Сб").slots[0].start).toBe("2026-08-29T06:00:00.000Z"); // 09:00 МСК
      // Воскресенье — выходной, слотов нет, но день в сетке остаётся.
      expect(dayOf(days, "Вс").closed).toBe(true);
    });

    it("занятость проверяется от выбранной недели вперёд", () => {
      const busy = [
        // Вт 25 августа, 09:00 МСК — первое наступление выбранной недели.
        { start: new Date("2026-08-25T06:00:00.000Z"), end: new Date("2026-08-25T07:00:00.000Z") },
      ];
      const slot = (opts: Parameters<typeof buildWeek>[2]) =>
        dayOf(buildWeek(busy, NOW, opts), "Вт").slots.find((s) => s.time === "09:00")!;

      expect(slot({ fromIso: FROM }).busy).toBe(true);
      // Та же занятость не касается ближайшей недели: это разные даты.
      expect(slot({}).busy).toBe(false);
    });

    it("часы, которые в выбранной неделе уже прошли, не показываются", () => {
      // «Сейчас» — четверг 16 июля, 12:00 МСК; выбрана его же неделя (Пн 13 — Вс 19).
      // Клиент такую неделю в from не отправляет (для текущей показывается обычная
      // сетка), но сервер обязан отвечать честно и на неё.
      const now = new Date("2026-07-16T09:00:00.000Z");
      const days = buildWeek([], now, { fromIso: "2026-07-16T09:00:00.000Z" });
      const all = days.flatMap((d) => d.slots);

      expect(all.every((s) => new Date(s.start).getTime() > now.getTime())).toBe(true);
      // Понедельник, вторник и среда этой недели уже прошли — их в сетке нет.
      for (const wd of ["Пн", "Вт", "Ср"]) expect(dayOf(days, wd).slots).toHaveLength(0);
      // Четверг: 09:00–11:20 прошли, с 12:30 записаться ещё можно.
      expect(dayOf(days, "Чт").slots[0].time).toBe("12:30");
      // Суббота 18-го — целиком впереди.
      expect(dayOf(days, "Сб").slots[0].start).toBe("2026-07-18T06:00:00.000Z");
    });

    it("окно запроса к календарю покрывает выбранную неделю и повторения", () => {
      const { timeMax } = weekWindowBounds(NOW, { fromIso: FROM, weeks: 4 });
      expect(timeMax.getTime()).toBeGreaterThan(new Date(FROM).getTime() + 4 * 7 * 86400000);
    });
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
