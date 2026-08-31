// Переписка с ботом не должна расти от каждого действия. Одна заметка раньше стоила
// четырёх сообщений: приглашение, твой текст, «сохранено» и карточка заново. Здесь
// проверяется, что результат ввода рисуется ПОВЕРХ приглашения, а панель дня живёт
// одним переписываемым сообщением.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPendingInput, promptStudentNote } from "@/lib/crm-bot";
import { refreshPanel, renderPanel } from "@/lib/panel";
import { deleteMessage, editMessageText, pinChatMessage, sendOwner } from "@/lib/telegram";
import { getState, setState } from "@/lib/botstate";
import { getSetting, setSetting } from "@/lib/settings";
import { listDayOccurrences } from "@/lib/google";
import { listDebtors } from "@/lib/stats";
import { updateStudent } from "@/lib/students";

vi.mock("@/lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram")>();
  return {
    ...actual,
    sendOwner: vi.fn(async () => ({ message_id: 77 })),
    sendTo: vi.fn(async () => ({ message_id: 77 })),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => {}),
    pinChatMessage: vi.fn(async () => {}),
    answerCallback: vi.fn(async () => {}),
    botUsername: vi.fn(async () => "bot"),
  };
});
vi.mock("@/lib/students", () => ({
  getStudent: vi.fn(async () => ({
    id: "stu-1",
    name: "Стас",
    subject: "Питон",
    contactKey: "key",
    rateKopecks: 100000,
    active: true,
    trial: false,
    note: "",
    tg: "",
    meetLink: "",
    boardLink: "",
    groupId: null,
  })),
  listStudents: vi.fn(async () => []),
  updateStudent: vi.fn(async () => {}),
  upsertStudent: vi.fn(),
  deleteStudent: vi.fn(),
  promoteStudentToFull: vi.fn(),
  setStudentLink: vi.fn(),
  setStudentArchived: vi.fn(),
}));
vi.mock("@/lib/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments")>();
  return {
    ...actual,
    listStudentPayments: vi.fn(async () => []),
    outstandingPayments: vi.fn(async () => []),
    paidPayments: vi.fn(async () => []),
    getPayment: vi.fn(),
    setPaymentStatus: vi.fn(),
    deletePayment: vi.fn(),
    createPayment: vi.fn(),
    setPayLink: vi.fn(),
  };
});
vi.mock("@/lib/google", () => ({
  listContactOccurrences: vi.fn(async () => []),
  listDayOccurrences: vi.fn(async () => []),
  calendarClient: vi.fn(),
  CALENDAR_ID: "cal",
  listSeriesMasters: vi.fn(async () => []),
  extendSeries: vi.fn(),
  lastOccurrenceOf: vi.fn(),
  setEventColor: vi.fn(),
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
vi.mock("@/lib/groups", () => ({ getGroup: vi.fn(async () => null), listGroups: vi.fn(async () => []) }));
vi.mock("@/lib/shortlink", () => ({ getOrCreateStudentLinkCode: vi.fn(async () => "abc123") }));
vi.mock("@/lib/autobill", () => ({ ensureAutoInvoices: vi.fn(async () => null) }));
vi.mock("@/lib/botstate", () => ({
  setState: vi.fn(async () => {}),
  getState: vi.fn(async () => null),
  clearState: vi.fn(async () => {}),
  promptIdOf: (st: { promptMessageId?: string } | null) => {
    const n = Number(st?.promptMessageId || 0);
    return n > 0 ? n : null;
  },
}));
vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async () => ""),
  setSetting: vi.fn(async () => {}),
  getPayMethod: vi.fn(async () => "yookassa"),
  getSbpDetails: vi.fn(async () => ""),
}));
vi.mock("@/lib/stats", () => ({
  computeIncomeStats: vi.fn(),
  computeWeekLoad: vi.fn(),
  listDebtors: vi.fn(async () => []),
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_CHAT_ID = "1";
  vi.mocked(sendOwner).mockResolvedValue({ message_id: 77 });
  vi.mocked(editMessageText).mockResolvedValue(true);
  vi.mocked(getSetting).mockResolvedValue("");
  vi.mocked(listDayOccurrences).mockResolvedValue([]);
  vi.mocked(listDebtors).mockResolvedValue([]);
});

describe("ввод текста не плодит сообщений", () => {
  it("приглашение запоминает свой id — поверх него потом рисуется экран", async () => {
    await promptStudentNote(1, "stu-1");
    expect(vi.mocked(setState)).toHaveBeenCalledWith("1", "student.note", "stu-1", 77);
  });

  it("заметка сохранена: карточка переписывает приглашение, новых сообщений нет", async () => {
    vi.mocked(getState).mockResolvedValue({
      chatId: "1",
      action: "student.note",
      targetId: "stu-1",
      promptMessageId: "77",
      updatedAt: new Date(),
    } as never);

    expect(await applyPendingInput(1, "разобрали словари")).toBe(true);

    expect(vi.mocked(updateStudent)).toHaveBeenCalledWith("stu-1", { note: "разобрали словари" });
    // Экран нарисован поверх приглашения…
    expect(vi.mocked(editMessageText).mock.calls[0][1]).toBe(77);
    // …и ни одного нового сообщения — в том числе никакого «✅ сохранено».
    expect(vi.mocked(sendOwner)).not.toHaveBeenCalled();
  });

  it("если приглашение удалили — экран всё равно доедет новым сообщением", async () => {
    vi.mocked(getState).mockResolvedValue({
      chatId: "1",
      action: "student.note",
      targetId: "stu-1",
      promptMessageId: "77",
      updatedAt: new Date(),
    } as never);
    vi.mocked(editMessageText).mockResolvedValue(false); // править нечего

    await applyPendingInput(1, "заметка");
    expect(vi.mocked(sendOwner)).toHaveBeenCalledTimes(1);
  });
});

describe("панель дня", () => {
  const occ = (h: number, student: string) => ({
    instanceId: `ev${h}`,
    start: new Date(`2026-09-02T${String(h - 3).padStart(2, "0")}:00:00.000Z`),
    hours: 1,
    colorId: null,
    student,
    subject: "Питон",
    studentId: "stu-1",
    groupId: "",
    contactKey: "key",
  });

  it("показывает занятия дня и долги одним сообщением", async () => {
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z")); // 15:00 МСК
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(10, "Амина"), occ(19, "Стас")] as never);
    vi.mocked(listDebtors).mockResolvedValue([
      { studentId: "stu-2", name: "Вася", debtKopecks: 150000, oldestAt: null, active: true },
    ] as never);

    const { text } = await renderPanel();
    expect(text).toContain("Амина");
    expect(text).toContain("Стас");
    expect(text).toContain("1 из 2 позади"); // 10:00 прошло, 19:00 впереди
    expect(text).toContain("Вася");
    // Разделитель разрядов у ru-RU — неразрывный пробел, поэтому \s, а не " ".
    expect(text).toMatch(/1\s500\s₽/);
  });

  it("обновление правит то же сообщение, а не шлёт новое", async () => {
    vi.mocked(getSetting).mockResolvedValue("500");
    await refreshPanel();
    expect(vi.mocked(editMessageText).mock.calls[0][1]).toBe(500);
    expect(vi.mocked(sendOwner)).not.toHaveBeenCalled();
  });

  it("по кнопке «Сегодня» панель показывается заново внизу — прежняя убирается", async () => {
    vi.mocked(getSetting).mockResolvedValue("500");
    await refreshPanel({ bump: true });
    expect(vi.mocked(deleteMessage)).toHaveBeenCalledWith("1", 500);
    expect(vi.mocked(sendOwner)).toHaveBeenCalledTimes(1);
    // Новая панель закрепляется и её id запоминается — иначе следующий прогон
    // отправил бы ещё одну.
    expect(vi.mocked(pinChatMessage)).toHaveBeenCalledWith("1", 77);
    expect(vi.mocked(setSetting)).toHaveBeenCalledWith("panelMessageId", "77");
  });
});
