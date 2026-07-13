// Пульс-крон /api/cron/pulse: вопрос «как прошло занятие?» сразу после его конца,
// с дедупликацией по lesson_pings и пропуском уже-серых (пропущенных) занятий.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/pulse/route";
import { listDayOccurrences } from "@/lib/google";
import { pingSent, recordPing } from "@/lib/pings";
import { sendOwner } from "@/lib/telegram";

vi.mock("@/lib/google", () => ({ listDayOccurrences: vi.fn(async () => []) }));
vi.mock("@/lib/pings", () => ({
  pingSent: vi.fn(async () => false),
  recordPing: vi.fn(async () => {}),
}));
vi.mock("@/lib/telegram", () => ({
  sendOwner: vi.fn(async () => {}),
  escapeHtml: (s: string) => s,
  inlineKeyboard: (rows: { text: string; data: string }[][]) => ({
    inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))),
  }),
}));

// «Сейчас»: 12:00 МСК. Занятие 10:00–11:00 МСК уже закончилось, 11:10–12:10 ещё идёт.
const NOW = new Date("2026-07-12T09:00:00.000Z");

function occ(startIso: string, over: Record<string, unknown> = {}) {
  return {
    instanceId: "ev1_a",
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
    new Request("http://test/api/cron/pulse", {
      headers: auth ? { authorization: auth } : {},
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  delete process.env.CRON_SECRET;
  vi.mocked(listDayOccurrences).mockResolvedValue([]);
  vi.mocked(pingSent).mockResolvedValue(false);
});

describe("/api/cron/pulse — «как прошло занятие?»", () => {
  it("закончившееся занятие → вопрос с кнопками и отметка о отправке", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ("2026-07-12T07:00:00.000Z")] as any);

    const res = await call();
    expect(await res.json()).toMatchObject({ ok: true, sent: 1 });

    const [text, keyboard] = vi.mocked(sendOwner).mock.calls[0] as any;
    expect(text).toContain("Занятие завершилось");
    expect(text).toContain("Тест Тестов");
    const kb = JSON.stringify(keyboard);
    expect(kb).toContain("ldone:ev1_a");
    expect(kb).toContain("lmiss:ev1_a");
    expect(kb).toContain("lrep:ev1_a");
    expect(recordPing).toHaveBeenCalledWith("ev1_a");
  });

  it("идущее занятие не трогаем (конец блока ещё впереди)", async () => {
    // 11:10 МСК, 2 часа: конец 13:20 МСК > сейчас (12:00) — рано спрашивать.
    vi.mocked(listDayOccurrences).mockResolvedValue([
      occ("2026-07-12T08:10:00.000Z", { hours: 2 }),
    ] as any);

    const res = await call();
    expect(await res.json()).toMatchObject({ sent: 0 });
    expect(sendOwner).not.toHaveBeenCalled();
    expect(recordPing).not.toHaveBeenCalled();
  });

  it("уже спрашивали (ping) — не дублируем", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ("2026-07-12T07:00:00.000Z")] as any);
    vi.mocked(pingSent).mockResolvedValue(true);

    const res = await call();
    expect(await res.json()).toMatchObject({ sent: 0 });
    expect(sendOwner).not.toHaveBeenCalled();
  });

  it("уже помечено пропуском (серое) — не спрашиваем", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([
      occ("2026-07-12T07:00:00.000Z", { colorId: "8" }),
    ] as any);

    const res = await call();
    expect(await res.json()).toMatchObject({ sent: 0 });
    expect(sendOwner).not.toHaveBeenCalled();
  });

  it("с CRON_SECRET чужие запросы отсекаются", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer s3cret")).status).toBe(200);
    delete process.env.CRON_SECRET;
  });
});
