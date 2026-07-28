// Кнопка 📝 в вопросе «как прошло занятие?»: заметка пишется к состоявшемуся занятию,
// поэтому она же подтверждает, что занятие прошло — сверяем счета и цвета.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { promptReportLessonNote } from "@/lib/crm-bot";
import { calendarClient } from "@/lib/google";
import { findOrCreateOccurrenceLesson } from "@/lib/lessons";
import { recolorStudent } from "@/lib/coloring";
import { ensureAutoInvoices } from "@/lib/autobill";
import { setState } from "@/lib/botstate";
import { sendOwner } from "@/lib/telegram";

vi.mock("@/lib/google", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google")>();
  return { ...actual, calendarClient: vi.fn() };
});
vi.mock("@/lib/lessons", () => ({
  findOrCreateOccurrenceLesson: vi.fn(async () => ({ id: "les-1", note: "" })),
  getLesson: vi.fn(),
  listStudentLessons: vi.fn(async () => []),
  setLessonNote: vi.fn(),
}));
vi.mock("@/lib/coloring", () => ({
  recolorStudent: vi.fn(async () => {}),
  markPastLessonsFree: vi.fn(async () => {}),
}));
vi.mock("@/lib/autobill", () => ({ ensureAutoInvoices: vi.fn(async () => null) }));
vi.mock("@/lib/students", () => ({
  getStudent: vi.fn(async () => ({ id: "stu-1", name: "Стас", subject: "Питон" })),
  listStudents: vi.fn(async () => []),
  updateStudent: vi.fn(),
  upsertStudent: vi.fn(),
  deleteStudent: vi.fn(),
  promoteStudentToFull: vi.fn(),
  setStudentMeetLink: vi.fn(),
}));
vi.mock("@/lib/botstate", () => ({
  setState: vi.fn(async () => {}),
  getState: vi.fn(async () => null),
  clearState: vi.fn(async () => {}),
}));
vi.mock("@/lib/telegram", () => ({
  sendOwner: vi.fn(async () => {}),
  editMessageText: vi.fn(async () => {}),
  escapeHtml: (s: string) => s,
  inlineKeyboard: (rows: unknown) => ({ inline_keyboard: rows }),
}));

const INSTANCE = "ev1_20260727T153000Z";

// Событие календаря, каким его отдаёт events.get.
function mockEvent(priv: Record<string, string> = {}) {
  vi.mocked(calendarClient).mockReturnValue({
    events: {
      get: vi.fn(async () => ({
        data: {
          id: INSTANCE,
          start: { dateTime: "2026-07-27T18:30:00+03:00" },
          extendedProperties: {
            private: { studentId: "stu-1", subject: "Питон", lessons: "1", ...priv },
          },
        },
      })),
    },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("📝 заметка к занятию — подтверждение, что оно состоялось", () => {
  it("сверяет счета и перекрашивает календарь, затем просит текст заметки", async () => {
    mockEvent();
    await promptReportLessonNote(1, INSTANCE);

    expect(ensureAutoInvoices).toHaveBeenCalledWith("stu-1", "Стас");
    expect(recolorStudent).toHaveBeenCalledWith("stu-1");
    // Строка занятия заводится по инстансу календаря, ввод заметки включён.
    expect(findOrCreateOccurrenceLesson).toHaveBeenCalled();
    expect(setState).toHaveBeenCalledWith("1", "lesson.note", "les-1");
    expect(vi.mocked(sendOwner).mock.calls[0][0]).toContain("Заметка к занятию");
  });

  it("сбой автосчетов не срывает ввод заметки и не мешает перекраске", async () => {
    mockEvent();
    vi.mocked(ensureAutoInvoices).mockRejectedValueOnce(new Error("БД недоступна"));

    await promptReportLessonNote(1, INSTANCE);
    expect(recolorStudent).toHaveBeenCalledWith("stu-1");
    expect(setState).toHaveBeenCalledWith("1", "lesson.note", "les-1");
  });

  it("события нет в календаре — ничего не пересчитываем", async () => {
    vi.mocked(calendarClient).mockReturnValue({
      events: { get: vi.fn(async () => Promise.reject(new Error("404"))) },
    } as never);

    await promptReportLessonNote(1, INSTANCE);
    expect(ensureAutoInvoices).not.toHaveBeenCalled();
    expect(recolorStudent).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it("занятие без привязки к ученику — пересчитывать нечего", async () => {
    mockEvent({ studentId: "" });

    await promptReportLessonNote(1, INSTANCE);
    expect(ensureAutoInvoices).not.toHaveBeenCalled();
    expect(recolorStudent).not.toHaveBeenCalled();
  });
});
