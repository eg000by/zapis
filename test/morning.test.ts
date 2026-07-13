// Утренний крон /api/cron/morning: вопрос про прошедшие пробные, отчёт «занятия
// за вчера» с кнопками «Прошло / Не прошло» и напоминания ученикам о сегодняшних.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/morning/route";
import { mskDayStart } from "@/lib/morning";
import { getStudent, listTrialPending, updateStudent } from "@/lib/students";
import { listContactOccurrences, listDayOccurrences } from "@/lib/google";
import { notifyStudent } from "@/lib/notify";
import { sendOwner } from "@/lib/telegram";

vi.mock("@/lib/students", () => ({
  listTrialPending: vi.fn(async () => []),
  updateStudent: vi.fn(async () => {}),
  getStudent: vi.fn(async () => null),
}));
vi.mock("@/lib/google", () => ({
  listContactOccurrences: vi.fn(async () => []),
  listDayOccurrences: vi.fn(async () => []),
}));
vi.mock("@/lib/telegram", () => ({
  sendOwner: vi.fn(async () => {}),
  escapeHtml: (s: string) => s,
  inlineKeyboard: (rows: { text: string; data: string }[][]) => ({
    inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))),
  }),
}));
vi.mock("@/lib/notify", () => ({ notifyStudent: vi.fn(async () => {}) }));

// «Сейчас»: воскресенье 12 июля 2026, 12:00 МСК. Вчера (МСК) — суббота 11 июля.
const NOW = new Date("2026-07-12T09:00:00.000Z");
const Y_START = mskDayStart(NOW, -1); // 2026-07-10T21:00Z
const T_START = mskDayStart(NOW, 0); // 2026-07-11T21:00Z

const STUDENT = {
  id: "stu-1",
  name: "Тест Тестов",
  subject: "Математика",
  tg: "@test",
  contactKey: "key",
};

function dayOcc(startIso: string, over: Record<string, unknown> = {}) {
  return {
    instanceId: `ev1_i`,
    start: new Date(startIso),
    hours: 1,
    colorId: null,
    student: "Тест Тестов",
    subject: "Математика",
    studentId: "stu-1",
    contactKey: "key",
    ...over,
  };
}

// Отчёт смотрит вчера, напоминания — сегодня: раздаём мок по окну запроса.
function mockDays(yesterday: unknown[], today: unknown[]) {
  vi.mocked(listDayOccurrences).mockImplementation(async (from: Date) =>
    from.getTime() === Y_START.getTime() ? (yesterday as any) : (today as any)
  );
}

function call(auth?: string) {
  return GET(
    new Request("http://test/api/cron/morning", {
      headers: auth ? { authorization: auth } : {},
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  delete process.env.CRON_SECRET;
  vi.mocked(listTrialPending).mockResolvedValue([]);
  vi.mocked(listContactOccurrences).mockResolvedValue([]);
  vi.mocked(listDayOccurrences).mockResolvedValue([]);
  vi.mocked(getStudent).mockResolvedValue(null);
});

describe("mskDayStart — границы суток МСК", () => {
  it("вчера начинается в 21:00 UTC позапрошлого дня (00:00 МСК)", () => {
    expect(Y_START.toISOString()).toBe("2026-07-10T21:00:00.000Z");
    expect(T_START.toISOString()).toBe("2026-07-11T21:00:00.000Z");
  });
});

describe("пробные: «пробное прошло, что дальше?»", () => {
  it("пробное прошло → владельцу вопрос с кнопками, повторно не спрашиваем", async () => {
    vi.mocked(listTrialPending).mockResolvedValue([STUDENT] as any);
    vi.mocked(listContactOccurrences).mockResolvedValue([
      { instanceId: "i", start: new Date("2026-07-10T15:10:00.000Z"), hours: 1, colorId: null },
    ] as any);

    const res = await call();
    expect((await res.json()).trial).toMatchObject({ checked: 1, notified: 1 });

    const [text, keyboard] = vi.mocked(sendOwner).mock.calls[0] as any;
    expect(text).toContain("Пробное занятие прошло");
    expect(JSON.stringify(keyboard)).toContain("mkfull:stu-1");
    expect(JSON.stringify(keyboard)).toContain("delstu:stu-1");
    expect(updateStudent).toHaveBeenCalledWith("stu-1", { trialNotifiedAt: expect.any(Date) });
  });

  it("пробное ещё впереди — молчим и не помечаем", async () => {
    vi.mocked(listTrialPending).mockResolvedValue([STUDENT] as any);
    vi.mocked(listContactOccurrences).mockResolvedValue([
      { instanceId: "i", start: new Date("2026-07-14T15:10:00.000Z"), hours: 1, colorId: null },
    ] as any);

    const res = await call();
    expect((await res.json()).trial).toMatchObject({ checked: 1, notified: 0 });
    expect(sendOwner).not.toHaveBeenCalled();
    expect(updateStudent).not.toHaveBeenCalled();
  });

  it("с CRON_SECRET чужие запросы отсекаются", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("Bearer s3cret")).status).toBe(200);
    delete process.env.CRON_SECRET;
  });
});

describe("отчёт «занятия за вчера»", () => {
  it("шлёт список с кнопками «Прошло» (ldone:) и «Не прошло» (lmiss:) на каждое занятие", async () => {
    mockDays(
      [
        dayOcc("2026-07-11T07:00:00.000Z", { instanceId: "ev1_a" }),
        dayOcc("2026-07-11T12:10:00.000Z", { instanceId: "ev2_b", student: "Второй" }),
      ],
      []
    );

    const res = await call();
    expect((await res.json()).report).toMatchObject({ lessons: 2 });

    const [text, keyboard] = vi.mocked(sendOwner).mock.calls[0] as any;
    expect(text).toContain("Занятия за вчера");
    expect(text).toContain("Тест Тестов");
    expect(text).toContain("Второй");
    const kb = JSON.stringify(keyboard);
    expect(kb).toContain("ldone:ev1_a");
    expect(kb).toContain("lmiss:ev1_a");
    expect(kb).toContain("lrep:ev1_a"); // 📝 заметка к занятию
    expect(kb).toContain("ldone:ev2_b");
    expect(kb).toContain("lmiss:ev2_b");
  });

  it("уже серое занятие помечается «уже отмечено пропуском»", async () => {
    mockDays([dayOcc("2026-07-11T07:00:00.000Z", { colorId: "8" })], []);
    await call();
    const [text] = vi.mocked(sendOwner).mock.calls[0] as any;
    expect(text).toContain("уже отмечено пропуском");
  });

  it("вчера занятий не было — отчёт не шлётся", async () => {
    mockDays([], []);
    const res = await call();
    expect((await res.json()).report).toMatchObject({ lessons: 0 });
    expect(sendOwner).not.toHaveBeenCalled();
  });
});

describe("напоминания ученикам о сегодняшних занятиях", () => {
  it("подключённому ученику уходит время занятия; блок из двух часов — одно сообщение", async () => {
    mockDays(
      [],
      [
        dayOcc("2026-07-12T12:10:00.000Z"),
        dayOcc("2026-07-12T13:20:00.000Z", { instanceId: "ev1_j" }),
      ]
    );
    vi.mocked(getStudent).mockResolvedValue({ ...STUDENT, tgChatId: "777" } as any);

    const res = await call();
    expect((await res.json()).reminders).toMatchObject({ reminders: 1 });
    expect(notifyStudent).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(notifyStudent).mock.calls[0] as any;
    expect(text).toContain("15:10, 16:20"); // МСК = UTC+3
  });

  it("не подключён (нет tgChatId) — не шлём", async () => {
    mockDays([], [dayOcc("2026-07-12T12:10:00.000Z")]);
    vi.mocked(getStudent).mockResolvedValue({ ...STUDENT, tgChatId: "" } as any);

    const res = await call();
    expect((await res.json()).reminders).toMatchObject({ reminders: 0 });
    expect(notifyStudent).not.toHaveBeenCalled();
  });

  it("сбой календаря в отчёте не срывает остальные задачи", async () => {
    vi.mocked(listDayOccurrences).mockRejectedValue(new Error("calendar down"));
    const res = await call();
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.report).toMatchObject({ error: "report" });
    expect(json.trial).toMatchObject({ checked: 0 });
  });
});
