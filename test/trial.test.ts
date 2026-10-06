// Быстрая запись пробного через бота: окна для родителя → время → «Маша ОГЭ».
// Календарь — фейковый (helpers/fake-google), БД и транспорт Telegram замоканы.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allStored, resetCalendar, seedEvent } from "./helpers/fake-google";
import {
  bookTrialByTeacher,
  formatTrialWindows,
  parseTrialLine,
  trialDays,
  undoTrial,
  type TrialDay,
} from "@/lib/trial";
import {
  applyTrialInput,
  chooseTrialSubject,
  packSlot,
  pickTrialSlot,
  showTrialWindows,
  unpackSlot,
} from "@/lib/trial-bot";
import { CALLBACK_DATA_LIMIT, editMessageText, sendOwner } from "@/lib/telegram";
import { deleteStudent, getStudent, upsertStudent } from "@/lib/students";
import { recordLesson } from "@/lib/lessons";

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
  deleteStudent: vi.fn(async () => {}),
}));
vi.mock("@/lib/lessons", () => ({
  recordLesson: vi.fn(async () => ({})),
  setLessonStatusByEvent: vi.fn(async () => {}),
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

// Кнопки последнего экрана, нарисованного правкой сообщения.
function lastButtons(): { text: string; callback_data: string }[] {
  const kb = vi.mocked(editMessageText).mock.calls.at(-1)?.[3] as any;
  return (kb?.inline_keyboard || []).flat();
}
const lastText = () => String(vi.mocked(editMessageText).mock.calls.at(-1)?.[2] ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  resetCalendar();
  state = null;
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
});

describe("окна для родителя", () => {
  const day = (label: string, weekday: string, slots: [string, string, boolean][]): TrialDay => ({
    label,
    weekday,
    slots: slots.map(([start, time, near]) => ({ start, time, near })),
  });
  const days = [
    day("Пн, 13 июл", "Пн", [["a", "15:00", true], ["b", "16:10", false]]),
    day("Вт, 14 июл", "Вт", [["c", "09:00", false]]),
  ];

  it("по умолчанию только рекомендуемые; дни без них не выводятся", () => {
    const f = formatTrialWindows(days, false);
    expect(f.text).toBe("Свободное время для пробного занятия (МСК):\nПн, 13 июл — 15:00");
    expect(f.slots.map((s) => s.start)).toEqual(["a"]);
    expect(f.fellBack).toBe(false);
  });

  it("«все свободные» — полный список", () => {
    const f = formatTrialWindows(days, true);
    expect(f.text).toContain("Пн, 13 июл — 15:00, 16:10\nВт, 14 июл — 09:00");
  });

  it("рекомендуемых нет — показываем все, чтобы было что отправить", () => {
    const f = formatTrialWindows([day("Вт, 14 июл", "Вт", [["c", "09:00", false]])], false);
    expect(f.fellBack).toBe(true);
    expect(f.slots).toHaveLength(1);
  });

  it("ближайшие 7 суток — по датам; занятые и рекомендуемые учтены", () => {
    const busy = [
      {
        start: new Date("2026-07-14T07:10:00.000Z"), // Вт 10:10
        end: new Date("2026-07-14T08:10:00.000Z"),
        lesson: true,
      },
    ];
    const d = trialDays(busy, NOW);
    // Вс 12 июля, 12:00: сегодня остался один час (12:20), а утро следующего
    // воскресенья — отдельной датой в конце, не в одной строке с сегодняшним.
    expect(d.map((x) => x.label)).toEqual([
      "Вс, 12 июл", "Пн, 13 июл", "Вт, 14 июл", "Ср, 15 июл", "Чт, 16 июл", "Сб, 18 июл", "Вс, 19 июл",
    ]);
    expect(d[0].slots.map((s) => s.time)).toEqual(["12:20"]);
    expect(d.at(-1)!.slots.map((s) => s.time)).toEqual(["10:00", "11:10"]);
    const tue = d.find((x) => x.label === "Вт, 14 июл")!;
    expect(tue.slots.some((s) => s.time === "10:10")).toBe(false); // занято
    expect(tue.slots.find((s) => s.time === "09:00")!.near).toBe(true); // вплотную
  });
});

describe("bookTrialByTeacher", () => {
  it("ставит подтверждённое разовое занятие и заводит пробного ученика", async () => {
    const r = await bookTrialByTeacher({ startIso: TUE_1120, name: "Маша", subject: "ОГЭ информатика" });
    expect(r.ok).toBe(true);
    expect(upsertStudent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Маша", subject: "ОГЭ информатика", trial: true })
    );
    const ev = allStored().find((e) => e.summary === "Маша — ОГЭ информатика")!;
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

  it("время успели занять — не записываем", async () => {
    lesson(TUE_1120);
    const r = await bookTrialByTeacher({ startIso: TUE_1120, name: "Маша", subject: "ОГЭ информатика" });
    expect(r).toEqual({ ok: false, reason: "Слот уже занят" });
    expect(upsertStudent).not.toHaveBeenCalled();
  });

  it("отмена удаляет событие и пустого пробного ученика", async () => {
    const r = await bookTrialByTeacher({ startIso: TUE_1120, name: "Маша", subject: "ОГЭ информатика" });
    if (!r.ok) throw new Error("не записалось");
    const key = (allStored()[0].extendedProperties?.private as any).contactKey;
    vi.mocked(getStudent).mockResolvedValue({ id: "stu-trial", trial: true, contactKey: key } as any);

    expect(await undoTrial(r.eventId, r.studentId)).toEqual({ removedStudent: true });
    expect(allStored().filter((e) => e.status !== "cancelled")).toHaveLength(0);
    expect(deleteStudent).toHaveBeenCalledWith("stu-trial");
  });

  it("у ученика есть другие занятия — отмена оставляет ученика", async () => {
    const r = await bookTrialByTeacher({ startIso: TUE_1120, name: "Маша", subject: "ОГЭ информатика" });
    if (!r.ok) throw new Error("не записалось");
    const key = (allStored()[0].extendedProperties?.private as any).contactKey;
    lesson("2026-07-16T06:00:00.000Z", {
      extendedProperties: { private: { app: "zapis", status: "confirmed", contactKey: key } },
    });
    vi.mocked(getStudent).mockResolvedValue({ id: "stu-trial", trial: true, contactKey: key } as any);

    expect(await undoTrial(r.eventId, r.studentId)).toEqual({ removedStudent: false });
    expect(deleteStudent).not.toHaveBeenCalled();
  });
});

describe("бот: окна → время → «кто придёт»", () => {
  it("время слота переживает кнопку туда и обратно", () => {
    expect(unpackSlot(packSlot(TUE_1120))).toBe(TUE_1120);
    expect(unpackSlot("")).toBeNull();
  });

  it("экран окон: текст для копирования и кнопки ≤ 64 байт", async () => {
    lesson("2026-07-14T07:10:00.000Z"); // Вт 10:10 → рядом 09:00 и 11:20
    await showTrialWindows(1, null);
    const text = String(vi.mocked(sendOwner).mock.calls.at(-1)![0]);
    expect(text).toContain("<pre>Свободное время для пробного занятия (МСК):");
    expect(text).toContain("Вт, 14 июл — 09:00, 11:20");
    const buttons = (vi.mocked(sendOwner).mock.calls.at(-1)![1] as any).inline_keyboard.flat();
    expect(buttons.map((b: any) => b.text)).toContain("Вт 11:20");
    for (const b of buttons) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
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

  it("предмет не распознан — кнопки предметов, затем запись", async () => {
    await pickTrialSlot(1, 50, `0:0:${packSlot(TUE_1120)}`);
    await applyTrialInput(1, state!.action, state!.targetId, "Петя", 50);
    expect(state?.action).toBe("trial.subj");
    expect(lastText()).toContain("Какой предмет?");

    await chooseTrialSubject(1, 50, 0); // «Питон» — первый в SUBJECTS
    expect(upsertStudent).toHaveBeenCalledWith(expect.objectContaining({ name: "Петя", subject: "Питон" }));
    expect(lastText()).toContain("Пробное записано");
  });

  it("время занято к моменту записи — понятная ошибка и путь назад к окнам", async () => {
    lesson(TUE_1120);
    await pickTrialSlot(1, 50, `0:0:${packSlot(TUE_1120)}`);
    await applyTrialInput(1, state!.action, state!.targetId, "Маша ОГЭ", 50);
    expect(lastText()).toContain("Не записано");
    expect(lastButtons().map((b) => b.callback_data)).toEqual(["trw:0:0"]);
  });
});
