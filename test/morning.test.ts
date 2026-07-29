// Утренний крон /api/cron/morning: вопрос о продлении заканчивающихся серий.
// Напоминания ученикам переехали в пульс (test/reminders.test.ts) — их момент
// зависит от времени занятия, а не от одного фиксированного запуска в 09:00.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/morning/route";
import { sendRenewalPrompts } from "@/lib/renew";

vi.mock("@/lib/renew", () => ({ sendRenewalPrompts: vi.fn(async () => ({ asked: 0 })) }));

const NOW = new Date("2026-07-12T09:00:00.000Z");

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
  vi.mocked(sendRenewalPrompts).mockResolvedValue({ asked: 0 } as never);
});

describe("/api/cron/morning", () => {
  it("спрашивает о продлении серий и отдаёт результат", async () => {
    vi.mocked(sendRenewalPrompts).mockResolvedValue({ asked: 2 } as never);

    const res = await call();
    expect(await res.json()).toMatchObject({ ok: true, renew: { asked: 2 } });
    expect(sendRenewalPrompts).toHaveBeenCalledOnce();
  });

  it("сбой продления не роняет крон молча — отвечает 500, чтобы это было видно", async () => {
    vi.mocked(sendRenewalPrompts).mockRejectedValueOnce(new Error("календарь недоступен"));
    expect((await call()).status).toBe(500);
  });

  it("с CRON_SECRET чужие запросы отсекаются", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("Bearer s3cret")).status).toBe(200);
    delete process.env.CRON_SECRET;
  });

  it("в проде без CRON_SECRET эндпоинт закрыт (503)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await call()).status).toBe(503);
    vi.unstubAllEnvs();
  });
});
