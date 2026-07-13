// Утренний крон /api/cron/morning: напоминания ученикам о сегодняшних занятиях.
// (Опрос «как прошло?» — в test/pulse.test.ts; решение по пробным — ручное.)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/morning/route";
import { mskDayStart } from "@/lib/morning";
import { getStudent } from "@/lib/students";
import { listDayOccurrences } from "@/lib/google";
import { notifyStudent } from "@/lib/notify";

vi.mock("@/lib/students", () => ({ getStudent: vi.fn(async () => null) }));
vi.mock("@/lib/google", () => ({ listDayOccurrences: vi.fn(async () => []) }));
vi.mock("@/lib/notify", () => ({ notifyStudent: vi.fn(async () => {}) }));

// «Сейчас»: воскресенье 12 июля 2026, 12:00 МСК.
const NOW = new Date("2026-07-12T09:00:00.000Z");

const STUDENT = {
  id: "stu-1",
  name: "Тест Тестов",
  subject: "Математика",
  tg: "@test",
  contactKey: "key",
};

function dayOcc(startIso: string, over: Record<string, unknown> = {}) {
  return {
    instanceId: "ev1_i",
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
  vi.mocked(listDayOccurrences).mockResolvedValue([]);
  vi.mocked(getStudent).mockResolvedValue(null);
});

describe("mskDayStart — границы суток МСК", () => {
  it("сутки МСК начинаются в 21:00 UTC предыдущего дня", () => {
    expect(mskDayStart(NOW, 0).toISOString()).toBe("2026-07-11T21:00:00.000Z");
    expect(mskDayStart(NOW, -1).toISOString()).toBe("2026-07-10T21:00:00.000Z");
  });
});

describe("напоминания ученикам о сегодняшних занятиях", () => {
  it("подключённому ученику уходит время занятия; блок из двух часов — одно сообщение", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([
      dayOcc("2026-07-12T12:10:00.000Z"),
      dayOcc("2026-07-12T13:20:00.000Z", { instanceId: "ev1_j" }),
    ] as any);
    vi.mocked(getStudent).mockResolvedValue({ ...STUDENT, tgChatId: "777" } as any);

    const res = await call();
    expect((await res.json()).reminders).toMatchObject({ reminders: 1 });
    expect(notifyStudent).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(notifyStudent).mock.calls[0] as any;
    expect(text).toContain("15:10, 16:20"); // МСК = UTC+3
  });

  it("не подключён (нет tgChatId) — не шлём", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([dayOcc("2026-07-12T12:10:00.000Z")] as any);
    vi.mocked(getStudent).mockResolvedValue({ ...STUDENT, tgChatId: "" } as any);

    const res = await call();
    expect((await res.json()).reminders).toMatchObject({ reminders: 0 });
    expect(notifyStudent).not.toHaveBeenCalled();
  });

  it("с CRON_SECRET чужие запросы отсекаются", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("Bearer s3cret")).status).toBe(200);
    delete process.env.CRON_SECRET;
  });
});
