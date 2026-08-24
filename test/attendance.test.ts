// Посещаемость группового занятия. Состояние экрана живёт в кнопках сообщения —
// проверяем и разбор клавиатуры, и то, что пропуск снимает тарификацию у одного
// ученика, не трогая занятие остальных.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAttendance,
  attendanceKeyboard,
  parseAttendance,
  toggleAttendance,
} from "@/lib/attendance";
import { activeMembers } from "@/lib/groups";
import { setAttendance } from "@/lib/lessons";
import { ensureAutoInvoices } from "@/lib/autobill";
import { editMessageReplyMarkup, editMessageText } from "@/lib/telegram";

const { eventsGet } = vi.hoisted(() => ({ eventsGet: vi.fn(async (): Promise<any> => ({})) }));
vi.mock("@/lib/google", () => ({
  CALENDAR_ID: "cal",
  calendarClient: vi.fn(() => ({ events: { get: eventsGet } })),
}));
vi.mock("@/lib/groups", () => ({ activeMembers: vi.fn(async () => []) }));
vi.mock("@/lib/lessons", () => ({ setAttendance: vi.fn(async () => {}) }));
vi.mock("@/lib/autobill", () => ({ ensureAutoInvoices: vi.fn(async () => null) }));
vi.mock("@/lib/telegram", () => ({
  escapeHtml: (s: string) => s,
  editMessageText: vi.fn(async () => {}),
  editMessageReplyMarkup: vi.fn(async () => {}),
}));

const MEMBERS = [
  { id: "s1", name: "Егор" },
  { id: "s2", name: "Дима" },
  { id: "s3", name: "Злата" },
];
const INSTANCE = "ev1_20260829T130000Z";
const START = "2026-08-29T13:00:00.000Z";

// Клавиатура в том виде, в каком её отдаёт Telegram в callback_query.
const markupOf = (absent: number[] = []) => ({
  inline_keyboard: attendanceKeyboard(MEMBERS, INSTANCE, new Set(absent)).map((row) =>
    row.map((b) => ({ text: b.text, callback_data: b.data }))
  ),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(activeMembers).mockResolvedValue(MEMBERS as never);
  eventsGet.mockResolvedValue({
    data: {
      start: { dateTime: START },
      extendedProperties: {
        private: { groupId: "grp-1", student: "ОГЭ, суббота", subject: "ОГЭ информатика", lessons: "1" },
      },
    },
  });
});

describe("клавиатура отметки", () => {
  it("по умолчанию отмечены все — обычный случай в одно нажатие", () => {
    const { names, absent } = parseAttendance(markupOf());
    expect(names).toEqual(["Егор", "Дима", "Злата"]);
    expect(absent.size).toBe(0);
  });

  it("id занятия помещается в callback_data (лимит Telegram — 64 байта)", () => {
    const rows = attendanceKeyboard(MEMBERS, INSTANCE);
    for (const row of rows) {
      for (const b of row) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64);
    }
  });

  it("нажатие переключает одного ученика, остальных не трогает", async () => {
    const note = await toggleAttendance(1, 42, markupOf(), 1);
    expect(note).toBe("Дима: пропуск");

    const sent = vi.mocked(editMessageReplyMarkup).mock.calls[0][2];
    const { absent, names } = parseAttendance(sent);
    expect([...absent]).toEqual([1]);
    expect(names).toEqual(["Егор", "Дима", "Злата"]);
  });

  it("повторное нажатие возвращает «был»", async () => {
    expect(await toggleAttendance(1, 42, markupOf([1]), 1)).toBe("Дима: был");
    expect(parseAttendance(vi.mocked(editMessageReplyMarkup).mock.calls[0][2]).absent.size).toBe(0);
  });
});

describe("применение отметки", () => {
  it("пропуск ставится только пропустившему, счета пересчитываются всем", async () => {
    const note = await applyAttendance(1, 42, INSTANCE, markupOf([2]));

    expect(note).toBe("Отмечено · пропусков: 1");
    const calls = vi.mocked(setAttendance).mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      expect.objectContaining({ studentId: "s1", present: true }),
      expect.objectContaining({ studentId: "s2", present: true }),
      expect.objectContaining({ studentId: "s3", present: false }),
    ]);
    expect(calls[0].occurrenceStart.toISOString()).toBe(START);
    // Счёт снимается сам: расчёт идёт от баланса целиком, а не «минус одно занятие».
    expect(vi.mocked(ensureAutoInvoices).mock.calls.map((c) => c[0])).toEqual(["s1", "s2", "s3"]);
    expect(String(vi.mocked(editMessageText).mock.calls[0][2])).toContain("Пропустили: Злата");
  });

  it("были все — так и пишем", async () => {
    expect(await applyAttendance(1, 42, INSTANCE, markupOf())).toBe("Отмечено · были все");
    expect(String(vi.mocked(editMessageText).mock.calls[0][2])).toContain("Были все");
  });

  it("состав изменился между сообщением и нажатием — ушедшего не трогаем", async () => {
    // Злату убрали из группы, пока сообщение висело: индекс 2 указывал бы на неё.
    vi.mocked(activeMembers).mockResolvedValue(MEMBERS.slice(0, 2) as never);
    await applyAttendance(1, 42, INSTANCE, markupOf([2]));
    expect(vi.mocked(setAttendance).mock.calls.map((c) => c[0].studentId)).toEqual(["s1", "s2"]);
  });

  it("занятие не групповое или не найдено — ничего не пишем", async () => {
    eventsGet.mockResolvedValue({ data: { start: { dateTime: START }, extendedProperties: {} } });
    expect(await applyAttendance(1, 42, INSTANCE, markupOf())).toBe("Это не групповое занятие");

    eventsGet.mockRejectedValueOnce(new Error("404"));
    expect(await applyAttendance(1, 42, INSTANCE, markupOf())).toBe("Занятие не найдено");
    expect(setAttendance).not.toHaveBeenCalled();
  });
});
