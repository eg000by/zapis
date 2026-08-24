// Архив ученика. Кнопка «В архив» раньше только снимала флаг active — будущие
// занятия оставались в календаре: держали время в сетке записи, красились по оплате
// и порождали напоминания «скоро занятие» тому, кто уже не занимается.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toggleStudentArchive } from "@/lib/crm-bot";
import { getStudent, setStudentArchived } from "@/lib/students";
import { sendOwner } from "@/lib/telegram";

vi.mock("@/lib/telegram", () => ({
  escapeHtml: (s: string) => s,
  inlineKeyboard: (rows: unknown) => ({ inline_keyboard: rows }),
  forceReply: () => ({ force_reply: true }),
  sendOwner: vi.fn(async () => {}),
  sendTo: vi.fn(async () => {}),
  editMessageText: vi.fn(async () => {}),
  answerCallback: vi.fn(async () => {}),
  botUsername: vi.fn(async () => "bot"),
}));
vi.mock("@/lib/students", () => ({
  getStudent: vi.fn(),
  setStudentArchived: vi.fn(async () => ({ removed: 0, calendarFailed: false })),
  listStudents: vi.fn(async () => []),
  updateStudent: vi.fn(),
  upsertStudent: vi.fn(),
  deleteStudent: vi.fn(),
  promoteStudentToFull: vi.fn(),
  setStudentMeetLink: vi.fn(),
}));
vi.mock("@/lib/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments")>();
  return {
    ...actual,
    listStudentPayments: vi.fn(async () => []),
    outstandingPayments: vi.fn(async () => []),
    getPayment: vi.fn(),
    setPaymentStatus: vi.fn(),
    deletePayment: vi.fn(),
    createPayment: vi.fn(),
    setPayLink: vi.fn(),
  };
});
vi.mock("@/lib/google", () => ({
  listContactOccurrences: vi.fn(async () => []),
  calendarClient: vi.fn(),
  CALENDAR_ID: "cal",
  deleteFutureEventsForContact: vi.fn(async () => 0),
  extendSeries: vi.fn(),
}));
vi.mock("@/lib/lessons", () => ({
  listStudentLessons: vi.fn(async () => []),
  findOrCreateOccurrenceLesson: vi.fn(),
  getLesson: vi.fn(),
  setLessonNote: vi.fn(),
}));
vi.mock("@/lib/coloring", () => ({
  recolorStudent: vi.fn(async () => {}),
  markPastLessonsFree: vi.fn(async () => {}),
}));
vi.mock("@/lib/shortlink", () => ({ getOrCreateStudentLinkCode: vi.fn(async () => "code") }));
vi.mock("@/lib/botstate", () => ({ setState: vi.fn(), getState: vi.fn(), clearState: vi.fn() }));
vi.mock("@/lib/autobill", () => ({ ensureAutoInvoices: vi.fn(async () => null) }));
vi.mock("@/lib/settings", () => ({
  getPayMethod: vi.fn(async () => "yookassa"),
  getSbpDetails: vi.fn(async () => ""),
  setPayMethod: vi.fn(),
  setSbpDetails: vi.fn(),
  setSetting: vi.fn(),
  DEFAULT_SBP_DETAILS: "",
}));
vi.mock("@/lib/stats", () => ({
  computeIncomeStats: vi.fn(),
  computeWeekLoad: vi.fn(),
  listDebtors: vi.fn(async () => []),
}));

const ACTIVE = { id: "stu-1", name: "Злата", subject: "ОГЭ информатика", active: true, rateKopecks: 100000 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setStudentArchived).mockResolvedValue({ removed: 0, calendarFailed: false });
});

describe("toggleStudentArchive", () => {
  it("активный уходит в архив вместе с будущими занятиями", async () => {
    vi.mocked(getStudent).mockResolvedValue(ACTIVE as never);
    vi.mocked(setStudentArchived).mockResolvedValue({ removed: 3, calendarFailed: false });

    const note = await toggleStudentArchive(1, null, "stu-1");

    expect(setStudentArchived).toHaveBeenCalledWith("stu-1", true);
    // Число снятых занятий видно сразу: иначе непонятно, освободилось ли время.
    expect(note).toBe("В архиве 🗄 · будущих занятий снято: 3");
    // Карточка перерисовывается — статус «архив» виден без лишних нажатий.
    expect(sendOwner).toHaveBeenCalled();
  });

  it("занятий впереди не было — так и пишем, без «снято: 0»", async () => {
    vi.mocked(getStudent).mockResolvedValue(ACTIVE as never);
    expect(await toggleStudentArchive(1, null, "stu-1")).toBe(
      "В архиве 🗄 · будущих занятий не было"
    );
  });

  it("календарь недоступен — архивация всё равно состоялась, и это сказано прямо", async () => {
    vi.mocked(getStudent).mockResolvedValue(ACTIVE as never);
    vi.mocked(setStudentArchived).mockResolvedValue({ removed: 0, calendarFailed: true });

    expect(await toggleStudentArchive(1, null, "stu-1")).toContain("календарь недоступен");
  });

  it("возврат из архива занятий не трогает", async () => {
    vi.mocked(getStudent).mockResolvedValue({ ...ACTIVE, active: false } as never);

    const note = await toggleStudentArchive(1, null, "stu-1");
    expect(setStudentArchived).toHaveBeenCalledWith("stu-1", false);
    expect(note).toBe("Снова активен ♻️");
  });

  it("ученика нет — ничего не архивируем", async () => {
    vi.mocked(getStudent).mockResolvedValue(null);
    expect(await toggleStudentArchive(1, null, "нет")).toBeNull();
    expect(setStudentArchived).not.toHaveBeenCalled();
  });
});
