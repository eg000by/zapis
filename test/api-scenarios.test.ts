// Сценарные тесты всех API-потоков: бронь → подтверждение → переносы (серия/разово)
// → возврат → отмена. Роуты и lib/google работают по-настоящему поверх фейкового
// Google Calendar (см. helpers/fake-google.ts); БД и Telegram-транспорт замоканы.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allStored,
  getStored,
  instanceIdFor,
  resetCalendar,
  seedEvent,
} from "./helpers/fake-google";
import { contactKey, encodeToken } from "@/lib/link";
import { answerCallback, editMessageText, notifyRequest, sendOwner, sendTo } from "@/lib/telegram";
import { markLessonMissed, recolorStudent, unmarkLessonMissed } from "@/lib/coloring";
import { setLessonStatusByEvent } from "@/lib/lessons";
import { getStudent, updateStudent } from "@/lib/students";
import { notifyStudentById } from "@/lib/notify";

vi.mock("googleapis", async () => {
  const { google } = await import("./helpers/fake-google");
  return { google, calendar_v3: {} };
});
vi.mock("@/lib/telegram", () => ({
  notifyRequest: vi.fn(async () => {}),
  sendOwner: vi.fn(async () => {}),
  sendTo: vi.fn(async () => {}),
  answerCallback: vi.fn(async () => {}),
  editMessageText: vi.fn(async () => {}),
  escapeHtml: (s: string) => s,
  inlineKeyboard: (rows: unknown) => ({ inline_keyboard: rows }),
  forceReply: () => ({ force_reply: true }),
  botUsername: vi.fn(async () => "test_bot"),
}));
vi.mock("@/lib/students", () => ({
  upsertStudent: vi.fn(async () => ({ id: "stu-1" })),
  getStudent: vi.fn(async () => null),
  getStudentByContactKey: vi.fn(async () => null),
  updateStudent: vi.fn(async () => {}),
}));
vi.mock("@/lib/notify", () => ({
  notifyStudent: vi.fn(async () => {}),
  notifyStudentById: vi.fn(async () => {}),
  studentTgInfo: vi.fn(async () => ({ connected: false, link: "" })),
}));
vi.mock("@/lib/lessons", () => ({
  recordLesson: vi.fn(async () => {}),
  setLessonStatusByEvent: vi.fn(async () => {}),
  updateLessonByEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/coloring", () => ({
  recolorStudent: vi.fn(async () => {}),
  markLessonMissed: vi.fn(async () => true),
  unmarkLessonMissed: vi.fn(async () => true),
}));
vi.mock("@/lib/payments", () => ({ outstandingPayments: vi.fn(async () => []) }));
// Автосчета тестируются отдельно (test/autobill.test.ts) — здесь глушим.
vi.mock("@/lib/autobill", () => ({ ensureAutoInvoices: vi.fn(async () => null) }));
vi.mock("@/lib/crm-bot", () => {
  const fns = [
    "applyPendingInput", "cancelPending", "chooseTrialForNew", "deletePaymentBot",
    "deleteStudentBot", "markPaymentPaid", "pickSubjectForNew", "promptDeletePayment",
    "promptDeleteStudent", "promptLessonNote", "promptNewPayment", "promptNewStudent",
    "makeStudentFull",
    "promptPaymentLink", "promptReportLessonNote", "promptStudentMeetLink", "promptStudentNote", "sendBookingLink", "showLessons",
    "showPayments", "showStudentCard", "showStudentsList", "submitRateForNew",
    "submitTgForNew", "toggleStudentArchive",
  ];
  const out: Record<string, unknown> = {};
  for (const f of fns) out[f] = vi.fn(async () => false);
  return out;
});

// «Сейчас»: суббота 12 июля 2026, 12:00 МСК.
const NOW = new Date("2026-07-12T09:00:00.000Z");
const INFO = { name: "Тест Тестов", subject: "Математика", tg: "@test", trial: false };
const TOKEN = () => encodeToken(INFO);
const KEY = () => contactKey(INFO);

// Слоты сетки (МСК): вторник 14 июля и его недельные повторы.
const TUE_1810 = "2026-07-14T15:10:00.000Z";
const TUE2_1810 = "2026-07-21T15:10:00.000Z";
const TUE3_1810 = "2026-07-28T15:10:00.000Z";
const WED_1810 = "2026-07-15T15:10:00.000Z";
const THU2_1810 = "2026-07-23T15:10:00.000Z";

const ROUTES = {
  book: () => import("@/app/api/book/route"),
  reschedule: () => import("@/app/api/reschedule/route"),
  cancel: () => import("@/app/api/cancel/route"),
  return: () => import("@/app/api/return/route"),
} as const;

async function post(path: keyof typeof ROUTES, body: unknown): Promise<{ status: number; json: any }> {
  const mod = await ROUTES[path]();
  const res = await mod.POST(
    new Request(`http://test/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}

async function getMy(token: string): Promise<any> {
  const mod = await import("@/app/api/my/route");
  const res = await mod.GET(new Request(`http://test/api/my?token=${encodeURIComponent(token)}`));
  return res.json();
}

// Крафтовый апдейт Telegram-вебхука от владельца.
async function tgCallback(data: string, opts: { secret?: string; chatId?: string } = {}) {
  const mod = await import("@/app/api/telegram/route");
  const res = await mod.POST(
    new Request("http://test/api/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": opts.secret ?? "test-webhook-secret",
      },
      body: JSON.stringify({
        callback_query: {
          id: "cb-1",
          data,
          message: { chat: { id: Number(opts.chatId ?? "111222333") }, message_id: 42 },
        },
      }),
    })
  );
  return res.status;
}

// Бронь + подтверждение через вебхук: возвращает id события.
async function bookConfirmed(start: string = TUE_1810): Promise<string> {
  const r = await post("book", { token: TOKEN(), start });
  expect(r.status).toBe(200);
  const id = allStored().filter((e) => e.status !== "cancelled").slice(-1)[0].id;
  await tgCallback(`c:${id}`);
  expect(getStored(id)?.extendedProperties?.private?.status).toBe("confirmed");
  return id;
}

function priv(id: string): Record<string, string> {
  return getStored(id)?.extendedProperties?.private || {};
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  resetCalendar();
});

// ───────────────────────────── /api/book ─────────────────────────────

describe("/api/book", () => {
  it("создаёт еженедельную серию в ожидании подтверждения", async () => {
    const r = await post("book", { token: TOKEN(), start: TUE_1810 });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.when).toContain("еженедельно");

    const [ev] = allStored();
    expect(ev.status).toBe("tentative");
    expect(ev.summary).toContain("⏳");
    expect(ev.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=26"]);
    expect(ev.extendedProperties?.private).toMatchObject({
      app: "zapis",
      status: "pending",
      contactKey: KEY(),
      lessons: "1",
      studentId: "stu-1",
    });
    expect(notifyRequest).toHaveBeenCalledOnce();
  });

  it("пробная ссылка — разовое событие без повтора", async () => {
    const trialToken = encodeToken({ ...INFO, trial: true });
    const r = await post("book", { token: trialToken, start: TUE_1810 });
    expect(r.status).toBe(200);
    expect(allStored()[0].recurrence).toBeUndefined();
  });

  it("битый токен → 403", async () => {
    const r = await post("book", { token: "мусор", start: TUE_1810 });
    expect(r.status).toBe(403);
  });

  it("занятый слот → 409", async () => {
    seedEvent({
      summary: "Чужое занятие",
      start: { dateTime: TUE_1810 },
      end: { dateTime: "2026-07-14T16:10:00.000Z" },
    });
    const r = await post("book", { token: TOKEN(), start: TUE_1810 });
    expect(r.status).toBe(409);
  });

  it("занятая будущая неделя не валит серию — уходит в EXDATE", async () => {
    seedEvent({
      summary: "Чужое занятие",
      start: { dateTime: TUE2_1810 },
      end: { dateTime: "2026-07-21T16:10:00.000Z" },
    });
    const r = await post("book", { token: TOKEN(), start: TUE_1810 });
    expect(r.status).toBe(200);
    const mine = allStored().find((e) => e.extendedProperties?.private?.app === "zapis")!;
    expect(mine.recurrence).toContain("EXDATE;TZID=Europe/Moscow:20260721T181000");
  });

  it("подряд идущие часы объединяются в один блок-событие", async () => {
    const r = await post("book", {
      token: TOKEN(),
      starts: ["2026-07-14T07:00:00.000Z", "2026-07-14T08:10:00.000Z"],
    });
    expect(r.status).toBe(200);
    expect(r.json.count).toBe(1);
    const [ev] = allStored();
    expect(ev.extendedProperties?.private?.lessons).toBe("2");
    expect(ev.end?.dateTime).toBe(new Date("2026-07-14T09:10:00.000Z").toISOString());
  });

  it("лимит занятий в неделю: сверх 4 часов → 409", async () => {
    const r1 = await post("book", {
      token: TOKEN(),
      starts: [
        "2026-07-14T07:00:00.000Z",
        "2026-07-14T08:10:00.000Z",
        "2026-07-14T09:20:00.000Z",
        "2026-07-14T10:30:00.000Z",
      ],
    });
    expect(r1.status).toBe(200);
    const r2 = await post("book", { token: TOKEN(), start: TUE_1810 });
    expect(r2.status).toBe(409);
    expect(r2.json.error).toContain("не больше 4");
  });

  it("разово перенесённое занятие не двоит недельную нагрузку", async () => {
    // Нагрузка 3 часа: блок из 2 + серия из 1.
    await post("book", {
      token: TOKEN(),
      starts: ["2026-07-14T07:00:00.000Z", "2026-07-14T08:10:00.000Z"],
    });
    const seriesId = await bookConfirmed(TUE_1810);
    // Разовый перенос одного занятия серии (создаёт исключение-инстанс moved=1).
    const r = await post("reschedule", {
      token: TOKEN(),
      eventId: seriesId,
      mode: "once",
      occStart: TUE2_1810,
      start: THU2_1810,
    });
    expect(r.status).toBe(200);
    // Итого по-прежнему 3 часа в неделю — четвёртый должен пройти (раньше двоился → 409).
    const r2 = await post("book", { token: TOKEN(), start: "2026-07-14T14:00:00.000Z" });
    expect(r2.status).toBe(200);
  });
});

// ───────────────────────── пробное занятие ─────────────────────────

describe("пробная ссылка — одно занятие", () => {
  const TRIAL = () => encodeToken({ ...INFO, trial: true });

  it("бронь по пробной ссылке — разовая, ученик помечается пробным", async () => {
    const r = await post("book", { token: TRIAL(), start: TUE_1810 });
    expect(r.status).toBe(200);
    const { upsertStudent } = await import("@/lib/students");
    expect(vi.mocked(upsertStudent).mock.calls.at(-1)![0]).toMatchObject({ trial: true });
  });

  it("несколько слотов за раз → 409", async () => {
    const r = await post("book", {
      token: TRIAL(),
      starts: ["2026-07-14T07:00:00.000Z", TUE_1810],
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("один слот");
    expect(allStored()).toHaveLength(0);
  });

  it("вторая запись при живом занятии → 409", async () => {
    await post("book", { token: TRIAL(), start: TUE_1810 });
    const r = await post("book", { token: TRIAL(), start: WED_1810 });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("только на одно занятие");
  });

  it("прошедшее пробное тоже блокирует новую запись (решает преподаватель)", async () => {
    seedEvent({
      start: { dateTime: "2026-07-10T15:10:00.000Z" }, // уже прошло
      end: { dateTime: "2026-07-10T16:10:00.000Z" },
      extendedProperties: { private: { app: "zapis", contactKey: contactKey({ ...INFO, trial: true }) } },
    });
    const r = await post("book", { token: TRIAL(), start: TUE_1810 });
    expect(r.status).toBe(409);
  });

  it("после отмены пробного можно записаться заново", async () => {
    await post("book", { token: TRIAL(), start: TUE_1810 });
    const id = allStored()[0].id;
    await post("cancel", { token: TRIAL(), eventId: id });
    const r = await post("book", { token: TRIAL(), start: WED_1810 });
    expect(r.status).toBe(200);
  });

  it("обычной ссылки ограничения не касаются", async () => {
    await post("book", { token: TOKEN(), start: TUE_1810 });
    const r = await post("book", { token: TOKEN(), start: WED_1810 });
    expect(r.status).toBe(200);
  });

  it("кнопка «Полноценный ученик» в боте диспатчится в makeStudentFull", async () => {
    const { makeStudentFull } = await import("@/lib/crm-bot");
    await tgCallback("mkfull:stu-1");
    expect(makeStudentFull).toHaveBeenCalledWith(111222333, 42, "stu-1");
  });
});

// ─────────────────────── /api/reschedule (серия) ───────────────────────

describe("/api/reschedule — вся серия", () => {
  it("переносит серию: снова pending, rev растёт, prevStart запомнен", async () => {
    const id = await bookConfirmed();
    const r = await post("reschedule", { token: TOKEN(), eventId: id, start: WED_1810 });
    expect(r.status).toBe(200);

    const ev = getStored(id)!;
    expect(ev.status).toBe("tentative");
    expect(new Date(ev.start!.dateTime!).toISOString()).toBe(WED_1810);
    expect(ev.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=26"]);
    expect(priv(id)).toMatchObject({ status: "pending", rev: "1" });
    expect(new Date(priv(id).prevStart).toISOString()).toBe(TUE_1810);
  });

  it("повторный перенос сохраняет prevStart последнего ПОДТВЕРЖДЁННОГО времени", async () => {
    const id = await bookConfirmed();
    await post("reschedule", { token: TOKEN(), eventId: id, start: WED_1810 });
    await post("reschedule", { token: TOKEN(), eventId: id, start: "2026-07-16T15:10:00.000Z" });
    expect(priv(id).rev).toBe("2");
    expect(new Date(priv(id).prevStart).toISOString()).toBe(TUE_1810);
  });

  it("чужая запись → 403", async () => {
    const id = await bookConfirmed();
    const foreign = encodeToken({ ...INFO, name: "Чужой" });
    const r = await post("reschedule", { token: foreign, eventId: id, start: WED_1810 });
    expect(r.status).toBe(403);
  });

  it("перенос на занятое время → 409, запись не тронута", async () => {
    const id = await bookConfirmed();
    seedEvent({
      summary: "Чужое занятие",
      start: { dateTime: WED_1810 },
      end: { dateTime: "2026-07-15T16:10:00.000Z" },
    });
    const r = await post("reschedule", { token: TOKEN(), eventId: id, start: WED_1810 });
    expect(r.status).toBe(409);
    expect(priv(id).status).toBe("confirmed");
  });
});

// ─────────────────────── /api/reschedule (разово) ───────────────────────

describe("/api/reschedule — одно занятие серии", () => {
  it("создаёт pending-исключение: moved, origStart, rev, цвет снят, пересчёт покраски", async () => {
    const id = await bookConfirmed();
    // Мастер покрашен — у перенесённого инстанса цвет должен сняться.
    const { fakeCalendar } = await import("./helpers/fake-google");
    await fakeCalendar.events.patch({ eventId: id, requestBody: { colorId: "10" } });

    const r = await post("reschedule", {
      token: TOKEN(),
      eventId: id,
      mode: "once",
      occStart: TUE2_1810,
      start: THU2_1810,
    });
    expect(r.status).toBe(200);
    expect(r.json.when).toContain("разовый перенос");

    const instId = instanceIdFor(id, TUE2_1810);
    const inst = getStored(instId)!;
    expect(inst.status).toBe("tentative");
    expect(inst.colorId).toBeNull();
    expect(new Date(inst.start!.dateTime!).toISOString()).toBe(THU2_1810);
    expect(priv(instId)).toMatchObject({ status: "pending", moved: "1", rev: "1" });
    expect(new Date(priv(instId).origStart).toISOString()).toBe(TUE2_1810);
    // Мастер-серия осталась на месте и подтверждённой.
    expect(priv(id).status).toBe("confirmed");
    expect(recolorStudent).toHaveBeenCalledWith("stu-1");
  });

  it("нельзя лечь поверх занятия своей же серии → 409", async () => {
    const id = await bookConfirmed();
    const r = await post("reschedule", {
      token: TOKEN(),
      eventId: id,
      mode: "once",
      occStart: TUE2_1810,
      start: TUE3_1810, // время другого занятия этой же серии
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("занят");
  });

  it("occStart мимо наступления серии → 404", async () => {
    const id = await bookConfirmed();
    const r = await post("reschedule", {
      token: TOKEN(),
      eventId: id,
      mode: "once",
      occStart: "2026-07-22T15:10:00.000Z", // среда — серия по вторникам
      start: THU2_1810,
    });
    expect(r.status).toBe(404);
  });

  it("повторный перенос инстанса: rev растёт, origStart остаётся первым", async () => {
    const id = await bookConfirmed();
    await post("reschedule", {
      token: TOKEN(), eventId: id, mode: "once", occStart: TUE2_1810, start: THU2_1810,
    });
    const instId = instanceIdFor(id, TUE2_1810);
    const r = await post("reschedule", {
      token: TOKEN(), eventId: instId, mode: "once", start: "2026-07-24T15:10:00.000Z",
    });
    expect(r.status).toBe(200);
    expect(priv(instId).rev).toBe("2");
    expect(new Date(priv(instId).origStart).toISOString()).toBe(TUE2_1810);
  });
});

// ───────────────────────────── /api/return ─────────────────────────────

describe("/api/return — вернуть разово перенесённое", () => {
  async function movedInstance(): Promise<string> {
    const id = await bookConfirmed();
    await post("reschedule", {
      token: TOKEN(), eventId: id, mode: "once", occStart: TUE2_1810, start: THU2_1810,
    });
    return instanceIdFor(id, TUE2_1810);
  }

  it("возвращает на исходное время, подтверждает, rev НЕ сбрасывается", async () => {
    const instId = await movedInstance();
    const r = await post("return", { token: TOKEN(), eventId: instId });
    expect(r.status).toBe(200);

    const inst = getStored(instId)!;
    expect(inst.status).toBe("confirmed");
    expect(new Date(inst.start!.dateTime!).toISOString()).toBe(TUE2_1810);
    expect(priv(instId)).toMatchObject({ status: "confirmed", moved: "", origStart: "" });
    // Монотонный счётчик ревизий: старая карточка cr:1 не пройдёт следующий цикл.
    expect(priv(instId).rev).toBe("1");
  });

  it("прежний слот занят другим → 409, перенос остаётся в силе", async () => {
    const instId = await movedInstance();
    seedEvent({
      summary: "Чужое занятие",
      start: { dateTime: TUE2_1810 },
      end: { dateTime: "2026-07-21T16:10:00.000Z" },
    });
    const r = await post("return", { token: TOKEN(), eventId: instId });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("уже поставлено другое занятие");
    expect(priv(instId).status).toBe("pending");
  });

  it("событие без переноса → 409", async () => {
    const id = await bookConfirmed();
    const r = await post("return", { token: TOKEN(), eventId: id });
    expect(r.status).toBe(409);
  });
});

// ───────────────────────────── /api/cancel ─────────────────────────────

describe("/api/cancel", () => {
  it("разовая отмена убирает одно занятие, серия живёт; повторная → 404", async () => {
    const id = await bookConfirmed();
    const r = await post("cancel", {
      token: TOKEN(), eventId: id, mode: "once", occStart: TUE2_1810,
    });
    expect(r.status).toBe(200);
    // Мастер жив, наступление 21 июля отменено.
    expect(getStored(id)?.status).not.toBe("cancelled");
    expect(getStored(instanceIdFor(id, TUE2_1810))?.status).toBe("cancelled");

    const again = await post("cancel", {
      token: TOKEN(), eventId: id, mode: "once", occStart: TUE2_1810,
    });
    expect(again.status).toBe(404);
  });

  it("отмена серии удаляет событие и синхронизирует CRM", async () => {
    const id = await bookConfirmed();
    const r = await post("cancel", { token: TOKEN(), eventId: id });
    expect(r.status).toBe(200);
    expect(getStored(id)).toBeUndefined();
    expect(setLessonStatusByEvent).toHaveBeenCalledWith(id, "cancelled");
  });

  it("уже удалённое событие → ok (отменять нечего)", async () => {
    const r = await post("cancel", { token: TOKEN(), eventId: "нет-такого" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  it("чужая запись → 403", async () => {
    const id = await bookConfirmed();
    const foreign = encodeToken({ ...INFO, name: "Чужой" });
    const r = await post("cancel", { token: foreign, eventId: id });
    expect(r.status).toBe(403);
    expect(getStored(id)).toBeDefined();
  });
});

// ──────────────────────────── /api/telegram ────────────────────────────

describe("/api/telegram — вебхук", () => {
  it("неверный секрет → 401", async () => {
    expect(await tgCallback("c:x", { secret: "wrong" })).toBe(401);
  });

  it("не владелец — доступ закрыт, событие не тронуто", async () => {
    const r = await post("book", { token: TOKEN(), start: TUE_1810 });
    expect(r.status).toBe(200);
    const id = allStored()[0].id;
    await tgCallback(`c:${id}`, { chatId: "999" });
    expect(answerCallback).toHaveBeenCalledWith("cb-1", "Нет доступа");
    expect(priv(id).status).toBe("pending");
  });

  it("подтверждение снимает префикс ожидания и красит занятия", async () => {
    await post("book", { token: TOKEN(), start: TUE_1810 });
    const id = allStored()[0].id;
    await tgCallback(`c:${id}`);
    const ev = getStored(id)!;
    expect(ev.status).toBe("confirmed");
    expect(ev.summary).not.toContain("⏳");
    expect(priv(id).status).toBe("confirmed");
    expect(recolorStudent).toHaveBeenCalledWith("stu-1");
  });

  it("устаревшая карточка после переноса не подтверждает старый слот", async () => {
    const id = await bookConfirmed();
    await post("reschedule", { token: TOKEN(), eventId: id, start: WED_1810 }); // rev=1
    await tgCallback(`c:${id}`); // плоская карточка первоначальной заявки (rev="")
    expect(priv(id).status).toBe("pending"); // не подтвердилось
    const [, , text] = vi.mocked(editMessageText).mock.calls.at(-1)!;
    expect(String(text)).toContain("устарел");
  });

  it("отклонение обычной заявки удаляет событие", async () => {
    await post("book", { token: TOKEN(), start: TUE_1810 });
    const id = allStored()[0].id;
    await tgCallback(`d:${id}`);
    expect(getStored(id)).toBeUndefined();
    expect(setLessonStatusByEvent).toHaveBeenCalledWith(id, "cancelled");
  });

  it("отклонение разового переноса возвращает занятие на место, rev монотонный", async () => {
    const id = await bookConfirmed();
    await post("reschedule", {
      token: TOKEN(), eventId: id, mode: "once", occStart: TUE2_1810, start: THU2_1810,
    });
    const instId = instanceIdFor(id, TUE2_1810);
    await tgCallback(`dr:1:${instId}`);

    const inst = getStored(instId)!;
    expect(inst.status).toBe("confirmed");
    expect(new Date(inst.start!.dateTime!).toISOString()).toBe(TUE2_1810);
    expect(priv(instId)).toMatchObject({ moved: "", origStart: "", rev: "1" });
  });

  it("отклонение разового переноса при занятом прежнем слоте оставляет всё как есть", async () => {
    const id = await bookConfirmed();
    await post("reschedule", {
      token: TOKEN(), eventId: id, mode: "once", occStart: TUE2_1810, start: THU2_1810,
    });
    seedEvent({
      summary: "Чужое занятие",
      start: { dateTime: TUE2_1810 },
      end: { dateTime: "2026-07-21T16:10:00.000Z" },
    });
    const instId = instanceIdFor(id, TUE2_1810);
    await tgCallback(`dr:1:${instId}`);

    expect(priv(instId).status).toBe("pending"); // перенос ждёт решения дальше
    const [, msg] = vi.mocked(answerCallback).mock.calls.at(-1)!;
    expect(String(msg)).toContain("Вернуть нельзя");
  });

  it("отклонение переноса СЕРИИ возвращает её на прежнее время, а не удаляет", async () => {
    const id = await bookConfirmed();
    await post("reschedule", { token: TOKEN(), eventId: id, start: WED_1810 });
    await tgCallback(`dr:1:${id}`);

    const ev = getStored(id)!;
    expect(ev.status).toBe("confirmed"); // серия ЖИВА
    expect(new Date(ev.start!.dateTime!).toISOString()).toBe(TUE_1810);
    expect(ev.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=26"]);
    expect(priv(id)).toMatchObject({ status: "confirmed", prevStart: "" });
  });

  it("отклонение переноса серии при занятом прежнем слоте оставляет pending", async () => {
    const id = await bookConfirmed();
    await post("reschedule", { token: TOKEN(), eventId: id, start: WED_1810 });
    seedEvent({
      summary: "Чужое занятие",
      start: { dateTime: TUE_1810 }, // ближайшее будущее наступление прежнего слота
      end: { dateTime: "2026-07-14T16:10:00.000Z" },
    });
    await tgCallback(`dr:1:${id}`);

    expect(priv(id).status).toBe("pending");
    expect(new Date(getStored(id)!.start!.dateTime!).toISOString()).toBe(WED_1810);
    const [, msg] = vi.mocked(answerCallback).mock.calls.at(-1)!;
    expect(String(msg)).toContain("Вернуть нельзя");
  });

  it("исчезнувшая заявка — вежливый ответ", async () => {
    await tgCallback("d:нет-такого");
    expect(answerCallback).toHaveBeenCalledWith(
      "cb-1",
      "Заявка не найдена (возможно, уже обработана)"
    );
  });
});

// ────────────────────────────── /api/my ──────────────────────────────

describe("/api/my — записи и плашка «ближайшее занятие»", () => {
  it("пусто для нового ученика", async () => {
    expect(await getMy(TOKEN())).toEqual({
      events: [],
      payments: [],
      balance: null,
      meetLink: "",
      tg: { connected: false, link: "" },
      nextLesson: null,
    });
  });

  it("отдаёт ссылку на Телемост из карточки ученика", async () => {
    const { getStudentByContactKey } = await import("@/lib/students");
    vi.mocked(getStudentByContactKey).mockResolvedValueOnce({
      id: "stu-1",
      name: "Тест Тестов",
      meetLink: "https://telemost.yandex.ru/j/12345",
    } as any);
    const my = await getMy(TOKEN());
    expect(my.meetLink).toBe("https://telemost.yandex.ru/j/12345");
  });

  it("отдаёт баланс и счета, когда ученик есть в CRM", async () => {
    const { getStudentByContactKey } = await import("@/lib/students");
    const { ensureAutoInvoices } = await import("@/lib/autobill");
    const { outstandingPayments } = await import("@/lib/payments");
    vi.mocked(getStudentByContactKey).mockResolvedValueOnce({
      id: "stu-1",
      name: "Тест Тестов",
    } as any);
    vi.mocked(ensureAutoInvoices).mockResolvedValueOnce({
      debtKopecks: 300000, debtHours: 2, aheadHours: 1,
      paidUntil: TUE_1810, balanceKopecks: 50000, rateKopecks: 150000,
      paidHours: 3, pastPaidHours: 2, leftoverHours: 0, items: [],
    } as any);
    vi.mocked(outstandingPayments).mockResolvedValueOnce([
      { id: "p1", amountKopecks: 300000, note: "Автосчёт: долг", payLink: "https://yk", kind: "debt" },
    ] as any);

    const my = await getMy(TOKEN());
    expect(ensureAutoInvoices).toHaveBeenCalledWith("stu-1", "Тест Тестов");
    expect(my.balance).toMatchObject({ debtKopecks: 300000, debtHours: 2, paidUntil: TUE_1810 });
    expect(my.payments).toEqual([
      { id: "p1", amountKopecks: 300000, note: "Автосчёт: долг", payLink: "https://yk", kind: "debt" },
    ]);
  });

  it("битый токен → 403", async () => {
    const mod = await import("@/app/api/my/route");
    const res = await mod.GET(new Request("http://test/api/my?token=мусор"));
    expect(res.status).toBe(403);
  });

  it("pending-заявка видна в списке, но не в плашке", async () => {
    await post("book", { token: TOKEN(), start: TUE_1810 });
    const my = await getMy(TOKEN());
    expect(my.events).toHaveLength(1);
    expect(my.events[0].status).toBe("pending");
    expect(my.nextLesson).toBeNull();
  });

  it("после подтверждения плашка показывает первое занятие", async () => {
    await bookConfirmed();
    const my = await getMy(TOKEN());
    expect(my.nextLesson).toBe(TUE_1810);
  });

  it("разово отменённое занятие пропадает из плашки (EXDATE)", async () => {
    const id = await bookConfirmed();
    await post("cancel", { token: TOKEN(), eventId: id, mode: "once", occStart: TUE_1810 });
    const my = await getMy(TOKEN());
    expect(my.nextLesson).toBe(TUE2_1810);
  });

  it("pending-перенос не считается ближайшим занятием", async () => {
    const id = await bookConfirmed();
    // Переносим ПЕРВОЕ занятие — плашка должна перескочить на следующее подтверждённое.
    await post("reschedule", {
      token: TOKEN(), eventId: id, mode: "once", occStart: TUE_1810, start: "2026-07-16T15:10:00.000Z",
    });
    const my = await getMy(TOKEN());
    expect(my.nextLesson).toBe(TUE2_1810);
    // А в списке перенос виден отдельной строкой со своим исходным временем.
    const movedRow = my.events.find((e: any) => e.moved);
    expect(movedRow.status).toBe("pending");
    expect(movedRow.origStart).toBe(TUE_1810);
  });

  it("подтверждённый разовый перенос попадает в плашку по новому времени", async () => {
    const id = await bookConfirmed();
    await post("reschedule", {
      token: TOKEN(), eventId: id, mode: "once", occStart: TUE_1810, start: "2026-07-13T15:10:00.000Z",
    });
    const instId = instanceIdFor(id, TUE_1810);
    await tgCallback(`cr:1:${instId}`);
    const my = await getMy(TOKEN());
    expect(my.nextLesson).toBe("2026-07-13T15:10:00.000Z");
  });
});

// ─────────────── Уведомления ученику + /start + кнопки отчёта ───────────────

// Крафтовое текстовое сообщение боту (не callback).
async function tgMessage(text: string, chatId: number) {
  const mod = await import("@/app/api/telegram/route");
  const res = await mod.POST(
    new Request("http://test/api/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret",
      },
      body: JSON.stringify({ message: { chat: { id: chatId }, text } }),
    })
  );
  return res.status;
}

describe("уведомления ученику в Telegram", () => {
  it("подтверждение заявки → уведомление ученику", async () => {
    await bookConfirmed();
    expect(notifyStudentById).toHaveBeenCalledWith(
      "stu-1",
      expect.stringContaining("подтверждена")
    );
  });

  it("отклонение заявки → уведомление ученику", async () => {
    await post("book", { token: TOKEN(), start: TUE_1810 });
    const id = allStored().slice(-1)[0].id;
    await tgCallback(`d:${id}`);
    expect(notifyStudentById).toHaveBeenCalledWith(
      "stu-1",
      expect.stringContaining("не подтверждена")
    );
  });

  it("/start <studentId> привязывает chat_id ученика (и не даёт CRM-доступа)", async () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    vi.mocked(getStudent).mockResolvedValueOnce({ id: uuid, name: "Тест", tgChatId: "" } as any);
    await tgMessage(`/start ${uuid}`, 999000111); // чужой чат ≠ владелец
    expect(updateStudent).toHaveBeenCalledWith(uuid, { tgChatId: "999000111" });
    expect(sendTo).toHaveBeenCalledWith(999000111, expect.stringContaining("Уведомления подключены"));
  });

  it("/start с неизвестным id — вежливый отказ, ничего не пишем в БД", async () => {
    await tgMessage("/start 123e4567-e89b-42d3-a456-426614174999", 999000111);
    expect(updateStudent).not.toHaveBeenCalled();
    expect(sendTo).toHaveBeenCalledWith(999000111, expect.stringContaining("не распознана"));
  });

  it("чужой чат без deep-link не получает CRM-команды", async () => {
    await tgMessage("/students", 999000111);
    expect(sendTo).not.toHaveBeenCalled();
    expect(sendOwner).not.toHaveBeenCalled();
  });
});

describe("кнопки утреннего отчёта", () => {
  it("«📝» → promptReportLessonNote с id инстанса", async () => {
    const { promptReportLessonNote } = await import("@/lib/crm-bot");
    await tgCallback("lrep:ev_x");
    expect(promptReportLessonNote).toHaveBeenCalledWith(111222333, "ev_x");
  });

  it("«Не прошло» → markLessonMissed, «Прошло» → unmarkLessonMissed", async () => {
    await tgCallback("lmiss:ev_x");
    expect(markLessonMissed).toHaveBeenCalledWith("ev_x");
    let [, msg] = vi.mocked(answerCallback).mock.calls.at(-1)!;
    expect(msg).toContain("Пропуск");

    await tgCallback("ldone:ev_x");
    expect(unmarkLessonMissed).toHaveBeenCalledWith("ev_x");
    [, msg] = vi.mocked(answerCallback).mock.calls.at(-1)!;
    expect(msg).toContain("учтено");
  });
});
