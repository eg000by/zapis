// Имя бота для deep-link в кабинете. Один сбой getMe раньше запоминался пустой
// строкой, и кнопка «Подключить уведомления» пропадала до холодного старта лямбды.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  delete process.env.TELEGRAM_BOT_USERNAME;
});
afterEach(() => vi.unstubAllGlobals());

const reply = (body: unknown) => ({ json: async () => body });

describe("botUsername", () => {
  it("сбой getMe не запоминается — следующий вызов спрашивает снова", async () => {
    const { botUsername } = await import("@/lib/telegram");
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await botUsername()).toBe("");

    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { username: "zapis_bot" } }));
    expect(await botUsername()).toBe("zapis_bot");
  });

  it("ответ без имени тоже не запоминается", async () => {
    const { botUsername } = await import("@/lib/telegram");
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error_code: 502, description: "Bad Gateway" }));
    expect(await botUsername()).toBe("");

    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { username: "zapis_bot" } }));
    expect(await botUsername()).toBe("zapis_bot");
  });

  it("удачный ответ кэшируется — getMe не дёргается на каждый кабинет", async () => {
    const { botUsername } = await import("@/lib/telegram");
    fetchMock.mockResolvedValue(reply({ ok: true, result: { username: "zapis_bot" } }));
    await botUsername();
    await botUsername();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("TELEGRAM_BOT_USERNAME из env важнее getMe", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "@from_env_bot";
    const { botUsername } = await import("@/lib/telegram");
    expect(await botUsername()).toBe("from_env_bot");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
