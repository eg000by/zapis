// Переписка с ботом не должна расти от каждого действия. Одна заметка раньше стоила
// четырёх сообщений: приглашение, твой текст, «сохранено» и карточка заново. Здесь
// проверяется, что результат ввода рисуется ПОВЕРХ приглашения, а панель дня живёт
// одним переписываемым сообщением.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPendingInput,
  promptStudentNote,
  showStats,
  showStudentsList,
  studentGrid,
} from "@/lib/crm-bot";
import { refreshPanel, renderPanel } from "@/lib/panel";
import { deleteMessage, editMessageText, pinChatMessage, sendOwner } from "@/lib/telegram";
import { getState, setState } from "@/lib/botstate";
import { getSetting, setSetting } from "@/lib/settings";
import { listDayOccurrences } from "@/lib/google";
import { computeIncomeStats, listDebtors } from "@/lib/stats";
import { getStudent, listStudents } from "@/lib/students";
import { getLesson, setLessonNote } from "@/lib/lessons";
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

  it("длинная заметка в приглашении укладывается в лимит Telegram и не рвёт разметку", async () => {
    // «&» при экранировании впятеро длиннее: 3 000 символов превращаются в 15 000.
    const note = "R&D ".repeat(1500);
    vi.mocked(getStudent).mockResolvedValueOnce({ id: "stu-1", note } as never);

    await promptStudentNote(1, "stu-1");

    const text = vi.mocked(sendOwner).mock.calls.at(-1)![0] as string;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/…<\/i>$/);
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/); // сущности не разрезаны
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

  // Заметку к прошедшему занятию пишут сразу после урока — в ответ хватает
  // подтверждения, список всех занятий ученика был лишним экраном.
  it("заметка к занятию: поверх приглашения только «✅ Заметка сохранена»", async () => {
    vi.mocked(getState).mockResolvedValue({
      chatId: "1",
      action: "lesson.note",
      targetId: "les-1",
      promptMessageId: "77",
      updatedAt: new Date(),
    } as never);
    vi.mocked(getLesson).mockResolvedValue({
      id: "les-1",
      studentId: "stu-1",
      occurrenceStart: new Date("2026-10-05T12:00:00.000Z"),
    } as never);

    expect(await applyPendingInput(1, "разобрали циклы")).toBe(true);

    expect(vi.mocked(setLessonNote)).toHaveBeenCalledWith("les-1", "разобрали циклы");
    const [, msgId, text, kb] = vi.mocked(editMessageText).mock.calls.at(-1)!;
    expect(msgId).toBe(77);
    expect(text).toBe("✅ Заметка сохранена · Стас, Пн, 5 октября, 15:00");
    expect(kb).toBeUndefined(); // без кнопок и без списка занятий
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

  it("показывает занятия дня одним сообщением", async () => {
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z")); // 15:00 МСК
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(10, "Амина"), occ(19, "Стас")] as never);

    const { text, keyboard } = await renderPanel();
    expect(text).toContain("Амина");
    expect(text).toContain("Стас");
    expect(text).toContain("1 из 2 позади"); // 10:00 прошло, 19:00 впереди
    // Кнопок у панели нет: любая из них переписала бы само закреплённое сообщение,
    // и в шапке чата вместо расписания оказывался бы открытый экран.
    expect(keyboard).toBeUndefined();
  });

  it("обновление правит то же сообщение, а не шлёт новое", async () => {
    vi.mocked(getSetting).mockResolvedValue("500");
    await refreshPanel();
    expect(vi.mocked(editMessageText).mock.calls[0][1]).toBe(500);
    expect(vi.mocked(sendOwner)).not.toHaveBeenCalled();
  });

  it("по /today панель показывается заново внизу — прежняя убирается", async () => {
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

// «Доходы» — полученные деньги и прогноз. Долг, «всего получено» и суммы
// неоплаченных счетов рядом с доходом путали: 118 000 «предложено одним платежом»
// читалось как деньги, хотя это лишь необязательные предложения ученикам.
describe("экран «Доходы»", () => {
  it("этот и прошлый месяц, прогноз, ученики и график — без долгов и неоплаченных счетов", async () => {
    vi.mocked(computeIncomeStats).mockResolvedValue({
      totalKopecks: 10750000,
      thisMonthKopecks: 4650000,
      prevMonthKopecks: 4240000,
      outstandingKopecks: 0,
      debtKopecks: 390000,
      advanceKopecks: 1770000,
      packageOfferKopecks: 11812000,
      activeStudents: 16,
      paidCount: 85,
      expectedMonthKopecks: 5340000,
      byMonth: [{ label: "сен", kopecks: 4650000 }],
    });

    await showStats(1, 5);

    const text = vi.mocked(editMessageText).mock.calls.at(-1)![2] as string;
    // Разряды rub() разделяет неразрывным пробелом.
    expect(text).toMatch(/За этот месяц: <b>46\s500 ₽<\/b>/);
    expect(text).toMatch(/За прошлый месяц: 42\s400 ₽/);
    expect(text).toMatch(/Прогноз на месяц: ~53\s400 ₽/);
    expect(text).toContain("Активных учеников: 16");
    for (const gone of ["Долг", "Всего получено", "Выставлено", "Предложено"]) {
      expect(text).not.toContain(gone);
    }
  });
});

// Список учеников должен помещаться на экран телефона: по одному в ряд
// («Имя · Предмет») он уходил за край уже на 16 учениках.
describe("список учеников", () => {
  const stu = (i: number, over: Record<string, unknown> = {}) => ({
    id: `s${i}`,
    name: `Ученик${String(i).padStart(2, "0")}`,
    subject: "Питон",
    trial: false,
    active: true,
    ...over,
  });

  it("по три в ряд, по алфавиту; предмет — только у тёзок", () => {
    const rows = studentGrid([
      stu(1, { name: "Вася" }),
      stu(2, { name: "Артем", subject: "ОГЭ информатика" }),
      stu(3, { name: "Артем", subject: "Питон" }),
      stu(4, { name: "Амина", trial: true }),
    ] as never);
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ["🎯 Амина", "Артем · ОГЭ", "Артем · Питон"],
      ["Вася"],
    ]);
  });

  it("16 учеников — 2 ряда меню и 6 рядов имён, без листания", async () => {
    vi.mocked(listStudents).mockResolvedValueOnce(
      Array.from({ length: 16 }, (_, i) => stu(i)) as never
    );
    await showStudentsList(1, 5);
    const kb = vi.mocked(editMessageText).mock.calls.at(-1)![3] as any;
    expect(kb.inline_keyboard).toHaveLength(2 + 6);
    expect(JSON.stringify(kb)).not.toContain("noop");
  });

  it("больше 21 — листается страницами", async () => {
    const many = Array.from({ length: 30 }, (_, i) => stu(i));
    vi.mocked(listStudents).mockResolvedValue(many as never);

    await showStudentsList(1, 5, false, 1);
    const kb = vi.mocked(editMessageText).mock.calls.at(-1)![3] as any;
    const rows = kb.inline_keyboard as { text: string; callback_data: string }[][];
    const nav = rows.at(-1)!;
    expect(nav.map((b) => b.text)).toEqual(["◀️", "2 / 2", "·"]);
    expect(nav[0].callback_data).toBe("stus:0");
    // На второй странице — оставшиеся 9 учеников (3 ряда) под меню.
    expect(rows.length).toBe(2 + 3 + 1);
    vi.mocked(listStudents).mockResolvedValue([]);
  });
});
