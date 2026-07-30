// Экраны бота не должны расти без предела: счета копятся каждую неделю, заметки —
// свободный текст. Telegram на сообщение длиннее 4096 символов отвечает ошибкой,
// а не обрезает его, — экран просто не открывается, и кнопка выглядит сломанной.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showLessons, showPaidHistory, showPayments } from "@/lib/crm-bot";
import { clampMessage, sendOwner } from "@/lib/telegram";
import { listStudentPayments } from "@/lib/payments";
import { listContactOccurrences } from "@/lib/google";
import { listStudentLessons } from "@/lib/lessons";

vi.mock("@/lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram")>();
  return {
    clampMessage: actual.clampMessage,
    escapeHtml: (s: string) => s,
    inlineKeyboard: (rows: unknown) => ({ inline_keyboard: rows }),
    forceReply: () => ({ force_reply: true }),
    sendOwner: vi.fn(async () => {}),
    sendTo: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
    answerCallback: vi.fn(async () => {}),
    botUsername: vi.fn(async () => "bot"),
  };
});
vi.mock("@/lib/students", () => ({
  getStudent: vi.fn(async () => ({ id: "stu-1", name: "Стас", contactKey: "key", rateKopecks: 100000 })),
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
  listSeriesMasters: vi.fn(async () => []),
  extendSeries: vi.fn(),
  lastOccurrenceOf: vi.fn(),
  listDayOccurrences: vi.fn(async () => []),
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
vi.mock("@/lib/botstate", () => ({ setState: vi.fn(), getState: vi.fn(), clearState: vi.fn() }));
vi.mock("@/lib/autobill", () => ({ ensureAutoInvoices: vi.fn(async () => null) }));
vi.mock("@/lib/settings", () => ({
  getPayMethod: vi.fn(async () => "yookassa"),
  getSbpDetails: vi.fn(async () => ""),
  setPayMethod: vi.fn(),
  setSbpDetails: vi.fn(),
}));
vi.mock("@/lib/stats", () => ({
  computeStats: vi.fn(),
  computeWeekLoad: vi.fn(),
  listDebtors: vi.fn(async () => []),
}));

// Что бот отправил: [текст, клавиатура].
function sent(): { text: string; rows: unknown[] } {
  const [text, kb] = vi.mocked(sendOwner).mock.calls[0] as [string, { inline_keyboard: unknown[] }];
  return { text, rows: kb?.inline_keyboard ?? [] };
}

const pay = (i: number, status: string) => ({
  id: `p${i}`,
  studentId: "stu-1",
  amountKopecks: 100000,
  status,
  kind: status === "paid" ? "debt" : "advance",
  note: `Автосчёт №${i}`,
  payLink: "",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date("2026-07-12T09:00:00.000Z"));
});

describe("clampMessage — предел Telegram в 4096 символов", () => {
  it("короткое сообщение не трогает", () => {
    expect(clampMessage("привет")).toBe("привет");
  });

  it("длинное режет по границе строк и сообщает, сколько скрыто", () => {
    const text = Array.from({ length: 500 }, (_, i) => `строка ${i} ————————————`).join("\n");
    const out = clampMessage(text);

    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out).toMatch(/… ещё \d+ строк/);
    // Режем целыми строками — незакрытых <b> и обрубков посередине не остаётся.
    const body = out.split("\n").slice(0, -1);
    expect(body.every((l) => /^строка \d+ ————————————$/.test(l))).toBe(true);
  });

  it("число скрытых строк согласовано с показанными", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${i}`.padEnd(30, "."));
    const out = clampMessage(lines.join("\n"));
    const hidden = Number(out.match(/… ещё (\d+)/)![1]);
    expect(out.split("\n").length - 1 + hidden).toBe(lines.length);
  });
});

describe("showPayments — неоплаченные целиком, оплаченные свёрнуты", () => {
  it("мало счетов — показываются все, отдельной страницы нет", async () => {
    vi.mocked(listStudentPayments).mockResolvedValue([
      pay(1, "unpaid"),
      pay(2, "paid"),
      pay(3, "paid"),
    ] as never);

    await showPayments(1, null, "stu-1");
    const { text, rows } = sent();
    expect(text).toContain("Автосчёт №1");
    expect(text).toContain("Автосчёт №3");
    expect(JSON.stringify(rows)).not.toContain("phist:");
  });

  it("много оплаченных — сводка и отдельная история вместо простыни", async () => {
    // 2 неоплаченных + 30 оплаченных: раньше это было 32 строки и до 34 рядов кнопок.
    const rowsIn = [
      pay(1, "unpaid"),
      pay(2, "unpaid"),
      ...Array.from({ length: 30 }, (_, i) => pay(100 + i, "paid")),
    ];
    vi.mocked(listStudentPayments).mockResolvedValue(rowsIn as never);

    await showPayments(1, null, "stu-1");
    const { text, rows } = sent();

    // Неоплаченные — все и с действиями: именно они требуют реакции.
    expect(text).toContain("Автосчёт №1");
    expect(text).toContain("Автосчёт №2");
    expect(text).toContain("Оплачено раньше (30)");
    expect(text).toContain("… и ещё 27");
    // Оплаченные дальше превью в текст не попадают.
    expect(text).not.toContain("Автосчёт №129");

    const kb = JSON.stringify(rows);
    expect(kb).toContain("phist:stu-1:0");
    // Кнопок удаления — только по неоплаченным, а не по всем тридцати двум.
    expect((kb.match(/delp:/g) || []).length).toBe(2);
    expect(rows.length).toBeLessThan(10);
  });
});

describe("showPaidHistory — постранично", () => {
  it("первая страница: 10 записей, кнопка «старее», без «новее»", async () => {
    vi.mocked(listStudentPayments).mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => pay(i, "paid")) as never
    );

    await showPaidHistory(1, null, "stu-1", 0);
    const { text, rows } = sent();
    expect(text).toContain("Всего оплачено счетов: <b>25</b>");
    expect(text).toContain("страница 1 из 3");
    expect(text).toContain("Автосчёт №9");
    expect(text).not.toContain("Автосчёт №10");

    const kb = JSON.stringify(rows);
    expect(kb).toContain("phist:stu-1:1");
    expect(kb).not.toContain("Новее");
  });

  it("страница за пределами списка прижимается к последней", async () => {
    vi.mocked(listStudentPayments).mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => pay(i, "paid")) as never
    );

    await showPaidHistory(1, null, "stu-1", 99);
    expect(sent().text).toContain("страница 2 из 2");
  });
});

describe("promptDeleteStudent — предупреждение должно совпадать с тем, что реально удаляется", () => {
  it("честно пишет, что будущие занятия уходят и из календаря", async () => {
    // Раньше здесь стояло «События в Google Calendar останутся», хотя
    // deleteStudentBot вызывает deleteFutureEventsForContact.
    const { promptDeleteStudent } = await import("@/lib/crm-bot");
    vi.mocked(listStudentPayments).mockResolvedValue([pay(1, "paid"), pay(2, "unpaid")] as never);

    await promptDeleteStudent(1, null, "stu-1");
    const { text } = sent();
    expect(text).toContain("Будущие занятия удалятся и из Google Calendar");
    expect(text).toContain("прошедшие останутся");
    expect(text).not.toContain("События в Google Calendar останутся");
    expect(text).toContain("счетов — 2");
  });
});

describe("showLessons — длинная заметка не занимает весь экран", () => {
  it("заметку длиннее 120 символов показывает началом с многоточием", async () => {
    const start = new Date("2026-07-10T07:00:00.000Z");
    vi.mocked(listContactOccurrences).mockResolvedValue([
      { instanceId: "i1", start, hours: 1, colorId: null },
    ] as never);
    const long = "разбирали рекурсию, ".repeat(20); // ~400 символов
    vi.mocked(listStudentLessons).mockResolvedValue([
      { id: "l1", note: long, occurrenceStart: start },
    ] as never);

    await showLessons(1, null, "stu-1");
    const { text } = sent();
    expect(text).toContain("…");
    expect(text).not.toContain(long);
    const noteLine = text.split("\n").find((l) => l.includes("📝"))!;
    expect(noteLine.length).toBeLessThan(140);
  });

  it("короткую заметку оставляет как есть", async () => {
    const start = new Date("2026-07-10T07:00:00.000Z");
    vi.mocked(listContactOccurrences).mockResolvedValue([
      { instanceId: "i1", start, hours: 1, colorId: null },
    ] as never);
    vi.mocked(listStudentLessons).mockResolvedValue([
      { id: "l1", note: "прошли словари", occurrenceStart: start },
    ] as never);

    await showLessons(1, null, "stu-1");
    expect(sent().text).toContain("📝 прошли словари");
    expect(sent().text).not.toContain("…");
  });
});
