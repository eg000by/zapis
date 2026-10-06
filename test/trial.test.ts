// Быстрая запись пробного через бота: окна для родителя → время → «Маша ОГЭ».
// Календарь — фейковый (helpers/fake-google), БД и транспорт Telegram замоканы.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allStored, resetCalendar, seedEvent } from "./helpers/fake-google";
import {
  bookTrialByTeacher,
  formatTrialWindows,
  normalizeSubject,
  parseTrialLine,
  trialDays,
  undoTrial,
  weekRangeLabel,
  type TrialDay,
} from "@/lib/trial";
import {
  applyTrialInput,
  chooseTrialSubject,
  confirmExistingTrial,
  packSlot,
  pickTrialSlot,
  showTrialWindows,
  undoTrialBot,
  unpackSlot,
} from "@/lib/trial-bot";
import { CALLBACK_DATA_LIMIT, editMessageText, packUuid, sendOwner } from "@/lib/telegram";
import {
  deleteStudent,
  getStudent,
  getStudentByContactKey,
  upsertStudent,
} from "@/lib/students";
import { listStudentLessons, recordLesson } from "@/lib/lessons";
import { listStudentPayments } from "@/lib/payments";
import { calendarClient } from "@/lib/google";

vi.mock("googleapis", async () => {
  const { google } = await import("./helpers/fake-google");
  return { google, calendar_v3: {} };
});
vi.mock("@/lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram")>();
  return {
    ...actual,
    sendOwner: vi.fn(async () => ({ message_id: 900 })),
    editMessageText: vi.fn(async () => true),
  };
});
vi.mock("@/lib/students", () => ({
  upsertStudent: vi.fn(async (i: any) => ({ id: "stu-trial", meetLink: "", boardLink: "", ...i })),
  getStudent: vi.fn(async () => null),
  getStudentByContactKey: vi.fn(async () => null),
  deleteStudent: vi.fn(async () => {}),
}));
vi.mock("@/lib/lessons", () => ({
  recordLesson: vi.fn(async () => ({})),
  setLessonStatusByEvent: vi.fn(async () => {}),
  listStudentLessons: vi.fn(async () => []),
}));
vi.mock("@/lib/payments", () => ({ listStudentPayments: vi.fn(async () => []) }));
// «Занятость» записи — в памяти, с той же семантикой, что у таблицы в БД.
const claims = new Set<string>();
vi.mock("@/lib/pings", () => ({
  claimOnce: vi.fn(async (k: string) => (claims.has(k) ? false : (claims.add(k), true))),
  releaseClaim: vi.fn(async (k: string) => {
    claims.delete(k);
  }),
}));
vi.mock("@/lib/shortlink", () => ({ getOrCreateStudentLinkCode: vi.fn(async () => "abc123") }));
vi.mock("@/lib/panel", () => ({ refreshPanel: vi.fn(async () => {}) }));
let state: { action: string; targetId: string } | null = null;
vi.mock("@/lib/botstate", () => ({
  getState: vi.fn(async () => state),
  setState: vi.fn(async (_c: string, action: string, targetId: string) => {
    state = { action, targetId };
  }),
  clearState: vi.fn(async () => {
    state = null;
  }),
  promptIdOf: vi.fn(() => null),
}));

// «Сейчас»: воскресенье 12 июля 2026, 12:00 МСК.
const NOW = new Date("2026-07-12T09:00:00.000Z");
const TUE_1120 = "2026-07-14T08:20:00.000Z"; // Вт 14 июля, 11:20 МСК

function lesson(startIso: string, over: Record<string, unknown> = {}) {
  const end = new Date(new Date(startIso).getTime() + 3600000).toISOString();
  return seedEvent({
    summary: "Ученик — Питон",
    start: { dateTime: startIso },
    end: { dateTime: end },
    extendedProperties: { private: { app: "zapis", status: "confirmed", contactKey: "other" } },
    ...over,
  } as any);
}

const live = () => allStored().filter((e) => e.status !== "cancelled");
// Кнопки и текст последнего экрана, нарисованного правкой сообщения.
function lastButtons(): { text: string; callback_data: string }[] {
  const kb = vi.mocked(editMessageText).mock.calls.at(-1)?.[3] as any;
  return (kb?.inline_keyboard || []).flat();
}
const lastText = () => String(vi.mocked(editMessageText).mock.calls.at(-1)?.[2] ?? "");

async function bookMasha() {
  const r = await bookTrialByTeacher({ startIso: TUE_1120, name: "Маша", subject: "ОГЭ информатика" });
  if (!r.ok) throw new Error(`не записалось: ${r.reason}`);
  const key = (live()[0].extendedProperties?.private as any).contactKey;
  return { r, key };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  resetCalendar();
  claims.clear();
  state = null;
  // mockResolvedValue переживает clearAllMocks — ответы по умолчанию задаём заново.
  vi.mocked(getStudentByContactKey).mockResolvedValue(null);
  vi.mocked(getStudent).mockResolvedValue(null);
  vi.mocked(listStudentPayments).mockResolvedValue([]);
  vi.mocked(listStudentLessons).mockResolvedValue([]);
  process.env.NEXT_PUBLIC_BASE_URL = "https://zapis.test";
});

describe("parseTrialLine — «Маша ОГЭ» одной строкой", () => {
  it.each([
    ["Маша ОГЭ", { name: "Маша", subject: "ОГЭ информатика", tg: "" }],
    ["Маша Иванова егэ @masha", { name: "Маша Иванова", subject: "ЕГЭ информатика", tg: "@masha" }],
    ["питон Петя", { name: "Петя", subject: "Питон", tg: "" }],
    ["Петя пробное по информатике ОГЭ", { name: "Петя", subject: "ОГЭ информатика", tg: "" }],
    ["Петя", { name: "Петя", subject: null, tg: "" }],
  ])("%s", (line, want) => {
    expect(parseTrialLine(line)).toEqual(want);
  });

  it("предмет словами приводится к каноническому, незнакомый — как написан", () => {
    expect(normalizeSubject("огэ")).toBe("ОГЭ информатика");
    expect(normalizeSubject("  Робототехника ")).toBe("Робототехника");
  });
});

describe("окна для родителя", () => {
  const day = (label: string, wd: string, n: number, slots: [string, string, boolean][]): TrialDay => ({
    label,
    weekday: wd,
    day: n,
    slots: slots.map(([start, time, near]) => ({ start, time, near })),
  });
  const days = [
    day("Пн, 13 июля", "Пн", 13, [["a", "15:00", true], ["b", "16:10", false]]),
    day("Вт, 14 июля", "Вт", 14, [["c", "09:00", false]]),
  ];

  it("по умолчанию только рекомендуемые; дни без них не выводятся", () => {
    const f = formatTrialWindows(days, false);
    expect(f.text).toBe("Свободное время для пробного занятия (МСК):\nПн, 13 июля — 15:00");
    expect(f.slots.map((s) => s.start)).toEqual(["a"]);
    expect(f.fellBack).toBe(false);
  });

  it("«все свободные» — полный список", () => {
    expect(formatTrialWindows(days, true).text).toContain("Пн, 13 июля — 15:00, 16:10\nВт, 14 июля — 09:00");
  });

  it("рекомендуемых нет — показываем все, чтобы было что отправить", () => {
    const f = formatTrialWindows([day("Вт, 14 июля", "Вт", 14, [["c", "09:00", false]])], false);
    expect(f.fellBack).toBe(true);
    expect(f.slots).toHaveLength(1);
  });

  it("страница — ровно 7 дат, шапка говорит про те же даты; занятые и рекомендуемые учтены", () => {
    const busy = [
      {
        start: new Date("2026-07-14T07:10:00.000Z"), // Вт 10:10
        end: new Date("2026-07-14T08:10:00.000Z"),
        lesson: true,
      },
    ];
    // Вс 12 июля, 12:00: сегодня остался один час (12:20). Утро следующего
    // воскресенья (19-е) — уже восьмая дата, его место на следующей странице.
    const d0 = trialDays(busy, NOW, 0);
    expect(weekRangeLabel(NOW, 0)).toBe("12–18 июля");
    expect(d0.map((x) => x.label)).toEqual([
      "Вс, 12 июля", "Пн, 13 июля", "Вт, 14 июля", "Ср, 15 июля", "Чт, 16 июля", "Сб, 18 июля",
    ]);
    expect(d0[0].slots.map((s) => s.time)).toEqual(["12:20"]);
    const tue = d0.find((x) => x.label === "Вт, 14 июля")!;
    expect(tue.slots.some((s) => s.time === "10:10")).toBe(false); // занято
    expect(tue.slots.find((s) => s.time === "09:00")!.near).toBe(true); // вплотную

    // Следующая страница начинается с полуночи 19-го: воскресенье целиком, с утра.
    const d1 = trialDays([], NOW, 1);
    expect(weekRangeLabel(NOW, 1)).toBe("19–25 июля");
    expect(d1[0].label).toBe("Вс, 19 июля");
    expect(d1[0].slots.map((s) => s.time)).toEqual(["10:00", "11:10", "12:20"]);
    expect(d1.at(-1)!.label).toBe("Сб, 25 июля");
  });
});

describe("bookTrialByTeacher", () => {
  it("ставит подтверждённое разовое занятие и заводит пробного ученика", async () => {
    await bookMasha();
    expect(upsertStudent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Маша", subject: "ОГЭ информатика", trial: true })
    );
    const ev = live().find((e) => e.summary === "Маша — ОГЭ информатика")!;
    expect(ev.status).toBe("confirmed");
    expect(ev.recurrence).toBeUndefined();
    expect(ev.extendedProperties?.private).toMatchObject({
      app: "zapis",
      status: "confirmed",
      studentId: "stu-trial",
      weeks: "1",
      lessons: "1",
    });
    expect(ev.description).toContain("Пробное занятие");
    expect(recordLesson).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmed" }));
  });

  it("время успели занять — не записываем и ученика не заводим", async () => {
    lesson(TUE_1120);
    const r = await bookTrialByTeacher({ startIso: TUE_1120, name: "Маша", subject: "ОГЭ информатика" });
    expect(r).toMatchObject({ ok: false, code: "taken", reason: "Слот уже занят" });
    expect(upsertStudent).not.toHaveBeenCalled();
  });

  it("двойное нажатие — второе не ставит второе событие", async () => {
    await bookMasha();
    // Второй апдейт успел пройти проверку слота до вставки первого — имитируем
    // это, убрав занятость из календаря, но «занятость» записи держит.
    resetCalendar();
    const again = await bookTrialByTeacher({ startIso: TUE_1120, name: "Маша", subject: "ОГЭ информатика" });
    expect(again).toMatchObject({ ok: false, code: "busy" });
  });

  it("календарь не ответил — заведённый ученик убирается, ошибка понятна", async () => {
    const real = calendarClient();
    vi.spyOn(real.events, "insert").mockRejectedValueOnce(new Error("503"));
    const r = await bookTrialByTeacher({ startIso: TUE_1120, name: "Маша", subject: "ОГЭ информатика" });
    expect(r).toMatchObject({ ok: false, code: "error" });
    expect(deleteStudent).toHaveBeenCalledWith("stu-trial");
    expect(claims.size).toBe(0); // можно сразу попробовать ещё раз
  });

  it("такой ученик уже есть и он не пробный — не вешаем на него «пробное» без спроса", async () => {
    vi.mocked(getStudentByContactKey).mockResolvedValue({ id: "stu-full", trial: false, meetLink: "", boardLink: "" } as any);
    const r = await bookTrialByTeacher({ startIso: TUE_1120, name: "Маша", subject: "ОГЭ информатика" });
    expect(r).toMatchObject({ ok: false, code: "exists" });
    expect(live()).toHaveLength(0);

    // Подтвердили — обычное разовое занятие этому ученику.
    const ok = await bookTrialByTeacher({
      startIso: TUE_1120,
      name: "Маша",
      subject: "ОГЭ информатика",
      toExisting: true,
    });
    expect(ok).toMatchObject({ ok: true, trial: false, studentId: "stu-full" });
    expect(upsertStudent).not.toHaveBeenCalled();
    expect(live()[0].description).toContain("Разовое занятие");
  });

  it("у пробного ученика уже стоит пробное — второе не ставим (как на сайте)", async () => {
    const { key } = await bookMasha();
    vi.mocked(getStudentByContactKey).mockResolvedValue({ id: "stu-trial", trial: true, contactKey: key } as any);
    const r = await bookTrialByTeacher({
      startIso: "2026-07-16T06:00:00.000Z",
      name: "Маша",
      subject: "ОГЭ информатика",
    });
    expect(r).toMatchObject({ ok: false, code: "has_trial" });
    expect(live()).toHaveLength(1);
  });
});

describe("undoTrial — отмена с экрана итога", () => {
  it("снимает событие и пустого пробного ученика", async () => {
    const { r, key } = await bookMasha();
    vi.mocked(getStudent).mockResolvedValue({ id: "stu-trial", trial: true, contactKey: key } as any);
    expect(await undoTrial(r.eventId, r.studentId, NOW)).toEqual({ ok: true, removedStudent: true });
    expect(live()).toHaveLength(0);
    expect(deleteStudent).toHaveBeenCalledWith("stu-trial");
    expect(claims.size).toBe(0); // это время можно записать снова
  });

  it("занятие уже началось — старая кнопка ничего не трогает", async () => {
    const { r } = await bookMasha();
    const later = new Date("2026-07-14T09:00:00.000Z"); // после начала
    const u = await undoTrial(r.eventId, r.studentId, later);
    expect(u.ok).toBe(false);
    expect(live()).toHaveLength(1);
    expect(deleteStudent).not.toHaveBeenCalled();
  });

  it("у ученика есть оплаты или заметки — ученик остаётся", async () => {
    const { r, key } = await bookMasha();
    vi.mocked(getStudent).mockResolvedValue({ id: "stu-trial", trial: true, contactKey: key } as any);
    vi.mocked(listStudentPayments).mockResolvedValueOnce([{ id: "p1" }] as any);
    expect(await undoTrial(r.eventId, r.studentId, NOW)).toEqual({ ok: true, removedStudent: false });
    expect(deleteStudent).not.toHaveBeenCalled();

    const again = await bookMasha();
    vi.mocked(listStudentLessons).mockResolvedValueOnce([{ note: "разобрали циклы" }] as any);
    expect(await undoTrial(again.r.eventId, again.r.studentId, NOW)).toEqual({
      ok: true,
      removedStudent: false,
    });
  });

  it("календарь не дал удалить — так и говорим, отменой не притворяемся", async () => {
    const { r } = await bookMasha();
    vi.spyOn(calendarClient().events, "delete").mockRejectedValueOnce(new Error("503"));
    const u = await undoTrial(r.eventId, r.studentId, NOW);
    expect(u).toMatchObject({ ok: false });
    expect(live()).toHaveLength(1);
  });
});

describe("бот: окна → время → «кто придёт»", () => {
  it("время слота переживает кнопку туда и обратно", () => {
    expect(unpackSlot(packSlot(TUE_1120))).toBe(TUE_1120);
    expect(unpackSlot("")).toBeNull();
  });

  it("экран окон: текст для копирования, на кнопках есть число, все ≤ 64 байт", async () => {
    lesson("2026-07-14T07:10:00.000Z"); // Вт 10:10 → рядом 09:00 и 11:20
    await showTrialWindows(1, null);
    const text = String(vi.mocked(sendOwner).mock.calls.at(-1)![0]);
    expect(text).toContain("<pre>Свободное время для пробного занятия (МСК):");
    expect(text).toContain("Вт, 14 июля — 09:00, 11:20");
    const buttons = (vi.mocked(sendOwner).mock.calls.at(-1)![1] as any).inline_keyboard.flat();
    expect(buttons.map((b: any) => b.text)).toContain("Вт 14 · 11:20");
    for (const b of buttons) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
  });

  it("старая кнопка «К окнам» не обрывает другой начатый ввод", async () => {
    state = { action: "payment.create", targetId: "stu-1" };
    await showTrialWindows(1, 5);
    expect(state).toEqual({ action: "payment.create", targetId: "stu-1" });
  });

  it("время → «Маша ОГЭ» → записано поверх того же сообщения, со ссылкой для родителя", async () => {
    await pickTrialSlot(1, 50, `0:0:${packSlot(TUE_1120)}`);
    expect(state?.action).toBe("trial.who");

    expect(await applyTrialInput(1, state!.action, state!.targetId, "Маша ОГЭ", 50)).toBe(true);

    const [, msgId, text] = vi.mocked(editMessageText).mock.calls.at(-1)!;
    expect(msgId).toBe(50);
    expect(text).toContain("✅ <b>Пробное записано</b>");
    expect(text).toContain("Маша · ОГЭ информатика");
    expect(text).toContain("https://zapis.test/z/abc123");
    expect(sendOwner).not.toHaveBeenCalled();
    for (const b of lastButtons()) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
    expect(lastButtons().some((b) => b.callback_data.startsWith("trundo:"))).toBe(true);
  });

  it("предмет не распознан — кнопки предметов (с привязкой к записи), затем запись", async () => {
    await pickTrialSlot(1, 50, `0:0:${packSlot(TUE_1120)}`);
    await applyTrialInput(1, state!.action, state!.targetId, "Петя", 50);
    expect(state?.action).toBe("trial.subj");
    expect(lastText()).toContain("Какой предмет?");
    const python = lastButtons().find((b) => b.text === "Питон")!;
    expect(python.callback_data).toBe(`trsub:0:${packSlot(TUE_1120)}`);

    await chooseTrialSubject(1, 50, python.callback_data.slice(6));
    expect(upsertStudent).toHaveBeenCalledWith(expect.objectContaining({ name: "Петя", subject: "Питон" }));
    expect(lastText()).toContain("Пробное записано");
  });

  it("кнопка предмета со старого экрана (другая запись) — устарела, никого не пишет", async () => {
    await pickTrialSlot(1, 50, `0:0:${packSlot(TUE_1120)}`);
    await applyTrialInput(1, state!.action, state!.targetId, "Петя", 50);
    const stale = `0:${packSlot("2026-07-16T06:00:00.000Z")}`; // время другой записи
    expect(await chooseTrialSubject(1, 50, stale)).toMatch(/устарел/);
    expect(upsertStudent).not.toHaveBeenCalled();
  });

  it("предмет словами на шаге кнопок нормализуется: «огэ» → «ОГЭ информатика»", async () => {
    await pickTrialSlot(1, 50, `0:0:${packSlot(TUE_1120)}`);
    await applyTrialInput(1, state!.action, state!.targetId, "Петя", 50);
    await applyTrialInput(1, state!.action, state!.targetId, "огэ", 50);
    expect(upsertStudent).toHaveBeenCalledWith(expect.objectContaining({ subject: "ОГЭ информатика" }));
  });

  it("такой ученик уже есть — спрашиваем; «Записать ему» ставит обычное занятие", async () => {
    vi.mocked(getStudentByContactKey).mockResolvedValue({ id: "stu-full", trial: false, meetLink: "", boardLink: "" } as any);
    await pickTrialSlot(1, 50, `0:0:${packSlot(TUE_1120)}`);
    await applyTrialInput(1, state!.action, state!.targetId, "Маша ОГЭ", 50);
    expect(lastText()).toContain("уже есть среди учеников");
    expect(live()).toHaveLength(0);

    await confirmExistingTrial(1, 50);
    expect(lastText()).toContain("Занятие записано");
    expect(live()).toHaveLength(1);
  });

  it("время занято к моменту записи — понятная ошибка и путь назад к окнам", async () => {
    lesson(TUE_1120);
    await pickTrialSlot(1, 50, `0:0:${packSlot(TUE_1120)}`);
    await applyTrialInput(1, state!.action, state!.targetId, "Маша ОГЭ", 50);
    expect(lastText()).toContain("Не записано");
    expect(lastButtons().map((b) => b.callback_data)).toEqual(["trw:0:0"]);
  });

  it("сбой посреди записи — экран не застывает на «Кто придёт?»", async () => {
    vi.mocked(upsertStudent).mockRejectedValueOnce(new Error("БД недоступна"));
    await pickTrialSlot(1, 50, `0:0:${packSlot(TUE_1120)}`);
    await applyTrialInput(1, state!.action, state!.targetId, "Маша ОГЭ", 50);
    expect(lastText()).toContain("Не записано");
  });

  it("отмена после начала занятия — отказ всплывашкой, экран итога не трогаем", async () => {
    const { r } = await bookMasha();
    vi.setSystemTime(new Date("2026-07-14T09:00:00.000Z"));
    const calls = vi.mocked(editMessageText).mock.calls.length;
    const msg = await undoTrialBot(1, 50, `${r.eventId}:${packUuid("00000000-0000-4000-8000-000000000001")}`);
    expect(msg).toMatch(/началось/);
    expect(vi.mocked(editMessageText).mock.calls.length).toBe(calls);
  });
});
