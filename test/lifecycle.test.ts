// «Месяц из жизни ученика» — один непрерывный сценарий сквозь настоящие модули:
// календарь (фейковый Google, но настоящий lib/google), настоящие balance,
// autobill и coloring поверх учёта оплат в памяти. Время двигается вперёд.
//
// Зачем отдельно от юнит-тестов: оба прод-бага (занятие Стаса не покрасилось;
// оплата вперёд гасилась новым счётом) жили НЕ внутри функции, а на стыке шагов —
// каждый шаг по отдельности был покрыт и зелёный. Ловится это только сценарием,
// где состояние переносится из шага в шаг.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStored, instanceIdFor, resetCalendar, seedEvent } from "./helpers/fake-google";

vi.mock("googleapis", async () => {
  const { google } = await import("./helpers/fake-google");
  return { google, calendar_v3: {} };
});

// ── Учёт оплат в памяти: та же семантика, что у lib/payments, но без БД ──────────
interface Row {
  id: string;
  studentId: string;
  amountKopecks: number;
  status: string;
  kind: string;
  note: string;
  payLink: string;
  providerPaymentId: string;
  paidAt: Date | null;
}
const { store } = vi.hoisted(() => ({ store: { rows: [] as Row[], seq: 0 } }));

vi.mock("@/lib/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments")>();
  return {
    findPackageInvoice: actual.findPackageInvoice,
    isPackageKind: actual.isPackageKind,
    packageKind: actual.packageKind,
    packageLessonsOf: actual.packageLessonsOf,
    summarizeOutstanding: actual.summarizeOutstanding,
    createPayment: vi.fn(async (input: any) => {
      const row: Row = {
        id: `p${++store.seq}`,
        studentId: input.studentId,
        amountKopecks: input.amountKopecks,
        status: "unpaid",
        kind: input.kind ?? "manual",
        note: input.note ?? "",
        payLink: input.payLink ?? "",
        providerPaymentId: "",
        paidAt: null,
      };
      store.rows.push(row);
      return row;
    }),
    updatePayment: vi.fn(async (id: string, patch: Partial<Row>) => {
      const row = store.rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    }),
    deletePayment: vi.fn(async (id: string) => {
      store.rows = store.rows.filter((r) => r.id !== id);
    }),
    outstandingPayments: vi.fn(async (studentId: string) =>
      store.rows.filter((r) => r.studentId === studentId && r.status === "unpaid")
    ),
    paidPayments: vi.fn(async (studentId: string) =>
      store.rows.filter((r) => r.studentId === studentId && r.status === "paid")
    ),
    setPaymentStatus: vi.fn(async (id: string, status: string) => {
      const row = store.rows.find((r) => r.id === id);
      if (row) {
        row.status = status;
        row.paidAt = status === "paid" ? new Date() : null;
      }
    }),
    // Тот же расчёт, что в БД-версии: пакетные счета кредитуют свои часы,
    // остальные — деньги ÷ ставку.
    paidHoursBreakdown: vi.fn(async (studentId: string, rate: number, fallback: number) => {
      let moneyKopecks = 0;
      let packageKopecks = 0;
      let packageHours = 0;
      for (const r of store.rows) {
        if (r.studentId !== studentId || r.status !== "paid") continue;
        const lessons = actual.isPackageKind(r.kind)
          ? actual.packageLessonsOf(r.kind, fallback)
          : 0;
        if (lessons > 0) {
          packageHours += lessons;
          packageKopecks += r.amountKopecks;
        } else {
          moneyKopecks += r.amountKopecks;
        }
      }
      return {
        paidHours: (rate > 0 ? Math.floor(moneyKopecks / rate) : 0) + packageHours,
        moneyKopecks,
        packageHours,
        packageKopecks,
      };
    }),
  };
});

const STUDENT = {
  id: "stu-1",
  name: "Стас",
  subject: "Питон",
  contactKey: "key-stas",
  rateKopecks: 100000, // 1000 ₽/час
  tgChatId: "",
  meetLink: "",
  trial: false,
};
vi.mock("@/lib/students", () => ({
  getStudent: vi.fn(async () => STUDENT),
  getStudentByContactKey: vi.fn(async () => STUDENT),
  listStudents: vi.fn(async () => [STUDENT]),
  updateStudent: vi.fn(async () => {}),
}));

// Транспорт и внешние сервисы к сценарию не относятся.
vi.mock("@/lib/telegram", () => ({
  sendOwner: vi.fn(async () => {}),
  sendTo: vi.fn(async () => {}),
  answerCallback: vi.fn(async () => {}),
  editMessageText: vi.fn(async () => {}),
  escapeHtml: (s: string) => s,
  inlineKeyboard: (rows: unknown) => ({ inline_keyboard: rows }),
}));
vi.mock("@/lib/notify", () => ({ notifyStudent: vi.fn(async () => {}) }));
vi.mock("@/lib/yookassa", () => ({
  yookassaConfigured: vi.fn(() => false),
  createYkPayment: vi.fn(async () => ({ id: "yk", confirmationUrl: "" })),
}));
vi.mock("@/lib/settings", () => ({
  getPayMethod: vi.fn(async () => "yookassa"),
  getSbpDetails: vi.fn(async () => ""),
}));
vi.mock("@/lib/lessons", () => ({
  findOrCreateOccurrenceLesson: vi.fn(async () => ({ id: "les-1", note: "" })),
  setLessonStatusByEvent: vi.fn(async () => {}),
  recordLesson: vi.fn(async () => {}),
  updateLessonByEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/botstate", () => ({
  setState: vi.fn(async () => {}),
  getState: vi.fn(async () => null),
  clearState: vi.fn(async () => {}),
}));
vi.mock("@/lib/pings", () => ({
  pingSent: vi.fn(async () => false),
  recordPing: vi.fn(async () => {}),
}));

// ── Сценарий ────────────────────────────────────────────────────────────────────
// Вт 14 июля 10:00 МСК и дальше еженедельно. «Сейчас» стартует за два дня до первого.
const FIRST = "2026-07-14T07:00:00.000Z";
const SERIES_ID = "ser-1";
const week = (n: number) => new Date(new Date(FIRST).getTime() + n * 7 * 86400000);

// Перемотка времени: «сейчас» = через `hours` после n-го занятия.
function afterLesson(n: number, hours = 2) {
  vi.setSystemTime(new Date(week(n).getTime() + hours * 3600000));
}

function seedSeries() {
  seedEvent({
    id: SERIES_ID,
    summary: "Стас — Питон",
    start: { dateTime: FIRST },
    end: { dateTime: new Date(new Date(FIRST).getTime() + 3600000).toISOString() },
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=6"],
    extendedProperties: {
      private: {
        app: "zapis",
        contactKey: STUDENT.contactKey,
        studentId: STUDENT.id,
        student: STUDENT.name,
        subject: STUDENT.subject,
        status: "confirmed",
        lessons: "1",
      },
    },
  } as never);
}

// Счета ученика по видам — читаемая картина «что сейчас висит».
function invoices() {
  return store.rows
    .filter((r) => r.status === "unpaid")
    .map((r) => ({ kind: r.kind, rub: r.amountKopecks / 100 }));
}

function payAll(kind: string) {
  for (const r of store.rows) {
    if (r.status === "unpaid" && r.kind === kind) {
      r.status = "paid";
      r.paidAt = new Date();
    }
  }
}

// Цвет конкретного повтора серии в календаре.
function colorOf(n: number): string | null | undefined {
  return getStored(instanceIdFor(SERIES_ID, week(n).toISOString()))?.colorId ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [];
  store.seq = 0;
  resetCalendar();
  vi.setSystemTime(new Date("2026-07-12T09:00:00.000Z"));
  seedSeries();
});

describe("месяц из жизни ученика — сквозной сценарий", () => {
  it("запись → счёт вперёд → оплата → занятие → долг → погашение", async () => {
    const { ensureAutoInvoices } = await import("@/lib/autobill");
    const { recolorStudent } = await import("@/lib/coloring");
    const { promptReportLessonNote } = await import("@/lib/crm-bot");

    // ── 1. Ученик открывает кабинет до первого занятия ────────────────────────
    // Ждём счёт ровно на одно ближайшее занятие плюс необязательное предложение
    // закрыть всё вперёд одним платежом. Долга нет — занятий ещё не было.
    // package:5, а не 6 — окно предложения AUTO_ADVANCE_DAYS = 30 дней, шестое
    // занятие серии в него уже не попадает.
    await ensureAutoInvoices(STUDENT.id, STUDENT.name);
    expect(invoices()).toEqual([
      { kind: "advance", rub: 1000 },
      { kind: "package:5", rub: 5000 },
    ]);

    // ── 2. Оплатил счёт «вперёд» ──────────────────────────────────────────────
    payAll("advance");
    await ensureAutoInvoices(STUDENT.id, STUDENT.name);
    // Регрессия прод-бага: нового счёта «вперёд» быть не должно — ближайшее
    // занятие закрыто балансом, платить прямо сейчас нечего.
    expect(invoices().some((i) => i.kind === "advance")).toBe(false);

    const { computeStudentBalance } = await import("@/lib/balance");
    const afterPay = await computeStudentBalance(STUDENT.id, STUDENT as never);
    expect(afterPay).toMatchObject({ nextPaid: true, aheadHours: 1, debtHours: 0 });

    // Оплаченное будущее занятие в календаре — оранжевое.
    await recolorStudent(STUDENT.id);
    expect(colorOf(0)).toBe("6");

    // ── 3. Первое занятие прошло, преподаватель нажал «Прошло» ────────────────
    afterLesson(0);
    await recolorStudent(STUDENT.id);
    expect(colorOf(0)).toBe("10"); // проведено и оплачено — зелёное
    await ensureAutoInvoices(STUDENT.id, STUDENT.name);
    expect(invoices().some((i) => i.kind === "debt")).toBe(false);
    // Ближайшим стало второе занятие — счёт «вперёд» появился снова, сам.
    expect(invoices().some((i) => i.kind === "advance")).toBe(true);

    // ── 4. Второе занятие прошло, но преподаватель НЕ нажал ничего ────────────
    // Продуктовое правило: нет решения преподавателя — нет покраски. Время само
    // по себе не означает, что занятие состоялось.
    afterLesson(1);
    expect(colorOf(1)).toBeNull();

    // ── 5. Нажал 📝 (заметка) — это и есть подтверждение, что занятие было ────
    await promptReportLessonNote(1, instanceIdFor(SERIES_ID, week(1).toISOString()));
    // Занятие не оплачено и уже прошло → долг и красный цвет.
    expect(invoices()).toContainEqual({ kind: "debt", rub: 1000 });
    expect(colorOf(1)).toBe("11");

    // ── 6. Долг погашен ───────────────────────────────────────────────────────
    payAll("debt");
    await ensureAutoInvoices(STUDENT.id, STUDENT.name);
    await recolorStudent(STUDENT.id);
    expect(colorOf(1)).toBe("10");
    expect(invoices().some((i) => i.kind === "debt")).toBe(false);
  });

  it("оплата вперёд одним платежом закрывает и долг, и будущие занятия", async () => {
    const { ensureAutoInvoices } = await import("@/lib/autobill");
    const { recolorStudent } = await import("@/lib/coloring");

    // Два занятия прошли без оплаты — накопился долг.
    afterLesson(1);
    await ensureAutoInvoices(STUDENT.id, STUDENT.name);
    expect(invoices()).toContainEqual({ kind: "debt", rub: 2000 });

    // Предложение «вперёд одним платежом» покрывает долг + оставшиеся занятия.
    const offer = invoices().find((i) => i.kind.startsWith("package:"))!;
    expect(offer.rub).toBe(6000); // 2 долга + 4 будущих по 1000 ₽

    payAll(offer.kind);
    await ensureAutoInvoices(STUDENT.id, STUDENT.name);
    await recolorStudent(STUDENT.id);

    // Долг закрыт, прошедшие зелёные, будущие оранжевые.
    expect(invoices().some((i) => i.kind === "debt" || i.kind === "advance")).toBe(false);
    expect(colorOf(0)).toBe("10");
    expect(colorOf(1)).toBe("10");
    expect(colorOf(2)).toBe("6");
  });

  it("отменённое занятие не превращается в долг и не ломает раскладку", async () => {
    const { CALENDAR_ID, calendarClient } = await import("@/lib/google");
    const { ensureAutoInvoices } = await import("@/lib/autobill");

    // Ученик отменил второе занятие заранее (сам роут /api/cancel проверяется
    // в api-scenarios — здесь важно только следствие для денег).
    await calendarClient().events.delete({
      calendarId: CALENDAR_ID,
      eventId: instanceIdFor(SERIES_ID, week(1).toISOString()),
    });

    // Прошли первое и (отменённое) второе — долг только за одно состоявшееся.
    afterLesson(1);
    await ensureAutoInvoices(STUDENT.id, STUDENT.name);
    expect(invoices()).toContainEqual({ kind: "debt", rub: 1000 });
  });
});
