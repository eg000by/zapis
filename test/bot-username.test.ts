// Имя бота для deep-link в кабинете. Один сбой getMe раньше запоминался пустой
// строкой навсегда, и кнопка «Подключить уведомления» пропадала до холодного старта;
// теперь неудача помнится минуту, а сам getMe — с таймаутом.
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
  it("сбой getMe помнится минуту, потом спрашиваем снова", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    const { botUsername } = await import("@/lib/telegram");
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await botUsername()).toBe("");

    // Сразу после сбоя кабинеты не дёргают Telegram каждый раз заново.
    expect(await botUsername()).toBe("");
    expect(fetchMock).toHaveBeenCalledOnce();

    now.mockReturnValue(t0 + 61000);
    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { username: "zapis_bot" } }));
    expect(await botUsername()).toBe("zapis_bot");
    now.mockRestore();
  });

  it("ответ без имени тоже не кэшируется навсегда", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    const { botUsername } = await import("@/lib/telegram");
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error_code: 502, description: "Bad Gateway" }));
    expect(await botUsername()).toBe("");

    now.mockReturnValue(t0 + 61000);
    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { username: "zapis_bot" } }));
    expect(await botUsername()).toBe("zapis_bot");
    now.mockRestore();
  });

  it("getMe идёт с таймаутом — кабинет не висит на Telegram", async () => {
    const { botUsername } = await import("@/lib/telegram");
    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { username: "zapis_bot" } }));
    await botUsername();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
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
