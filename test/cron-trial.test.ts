import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/trial/route";
import { listTrialPending, updateStudent } from "@/lib/students";
import { listContactOccurrences } from "@/lib/google";
import { sendOwner } from "@/lib/telegram";

vi.mock("@/lib/students", () => ({
  listTrialPending: vi.fn(async () => []),
  updateStudent: vi.fn(async () => {}),
}));
vi.mock("@/lib/google", () => ({ listContactOccurrences: vi.fn(async () => []) }));
vi.mock("@/lib/telegram", () => ({
  sendOwner: vi.fn(async () => {}),
  escapeHtml: (s: string) => s,
  inlineKeyboard: (rows: { text: string; data: string }[][]) => ({
    inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))),
  }),
}));

const NOW = new Date("2026-07-12T09:00:00.000Z");

const STUDENT = {
  id: "stu-1",
  name: "Тест Тестов",
  subject: "Математика",
  tg: "@test",
  contactKey: "key",
};

function occ(startIso: string) {
  return { instanceId: "i", start: new Date(startIso), hours: 1, colorId: null };
}

function call(auth?: string) {
  return GET(
    new Request("http://test/api/cron/trial", {
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
});

describe("/api/cron/trial — «пробное прошло, что дальше?»", () => {
  it("пробное прошло → владельцу вопрос с кнопками, повторно не спрашиваем", async () => {
    vi.mocked(listTrialPending).mockResolvedValue([STUDENT] as any);
    vi.mocked(listContactOccurrences).mockResolvedValue([
      occ("2026-07-10T15:10:00.000Z"), // прошло
    ] as any);

    const res = await call();
    expect(await res.json()).toMatchObject({ ok: true, checked: 1, notified: 1 });

    const [text, keyboard] = vi.mocked(sendOwner).mock.calls[0] as any;
    expect(text).toContain("Пробное занятие прошло");
    expect(text).toContain("Тест Тестов");
    expect(JSON.stringify(keyboard)).toContain("mkfull:stu-1");
    expect(JSON.stringify(keyboard)).toContain("delstu:stu-1");
    // Отметка «уже спросили» — чтобы завтрашний крон не дублировал вопрос.
    expect(updateStudent).toHaveBeenCalledWith("stu-1", { trialNotifiedAt: expect.any(Date) });
  });

  it("пробное ещё впереди — молчим и не помечаем", async () => {
    vi.mocked(listTrialPending).mockResolvedValue([STUDENT] as any);
    vi.mocked(listContactOccurrences).mockResolvedValue([
      occ("2026-07-14T15:10:00.000Z"), // будущее
    ] as any);

    const res = await call();
    expect(await res.json()).toMatchObject({ checked: 1, notified: 0 });
    expect(sendOwner).not.toHaveBeenCalled();
    expect(updateStudent).not.toHaveBeenCalled();
  });

  it("пробный без записи вовсе — пропускается", async () => {
    vi.mocked(listTrialPending).mockResolvedValue([STUDENT] as any);
    const res = await call();
    expect(await res.json()).toMatchObject({ notified: 0 });
  });

  it("сбой на одном ученике не срывает остальных", async () => {
    vi.mocked(listTrialPending).mockResolvedValue([
      { ...STUDENT, id: "bad", contactKey: "bad" },
      STUDENT,
    ] as any);
    vi.mocked(listContactOccurrences)
      .mockRejectedValueOnce(new Error("calendar down"))
      .mockResolvedValueOnce([occ("2026-07-10T15:10:00.000Z")] as any);

    const res = await call();
    expect(await res.json()).toMatchObject({ checked: 2, notified: 1 });
  });

  it("с CRON_SECRET чужие запросы отсекаются", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("Bearer s3cret")).status).toBe(200);
    delete process.env.CRON_SECRET;
  });
});
