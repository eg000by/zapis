// sendOnce: «отправить ровно один раз», когда пульс дёргают два планировщика.
// Отметка — после отправки, одновременные прогоны разводит протухающая аренда.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendOnce, LEASE_TTL_MS } from "@/lib/once";
import { claimLease, pingSent, recordPing, releaseClaim } from "@/lib/pings";

vi.mock("@/lib/pings", () => ({
  pingSent: vi.fn(async () => false),
  claimLease: vi.fn(async () => true),
  recordPing: vi.fn(async () => {}),
  releaseClaim: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pingSent).mockResolvedValue(false);
  vi.mocked(claimLease).mockResolvedValue(true);
});

describe("sendOnce", () => {
  it("отправляет, ставит отметку и снимает аренду", async () => {
    const send = vi.fn(async () => {});
    expect(await sendOnce("rem:k", send)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(claimLease).toHaveBeenCalledWith("lock:rem:k", LEASE_TTL_MS);
    expect(recordPing).toHaveBeenCalledWith("rem:k");
    expect(releaseClaim).toHaveBeenCalledWith("lock:rem:k");
  });

  it("уже отправлено — аренду даже не берём", async () => {
    vi.mocked(pingSent).mockResolvedValue(true);
    const send = vi.fn(async () => {});
    expect(await sendOnce("rem:k", send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(claimLease).not.toHaveBeenCalled();
  });

  it("аренда у соседнего прогона — молчим", async () => {
    vi.mocked(claimLease).mockResolvedValue(false);
    const send = vi.fn(async () => {});
    expect(await sendOnce("rem:k", send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(recordPing).not.toHaveBeenCalled();
  });

  it("сосед успел отправить между проверкой и арендой — второй копии нет", async () => {
    // Первая проверка — ещё не отправлено; под арендой — уже отправлено.
    vi.mocked(pingSent).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const send = vi.fn(async () => {});
    expect(await sendOnce("rem:k", send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith("lock:rem:k");
  });

  it("send бросил — отметки нет, аренда снята, ошибка наружу", async () => {
    const send = vi.fn(async () => {
      throw new Error("Telegram недоступен");
    });
    await expect(sendOnce("rem:k", send)).rejects.toThrow("Telegram недоступен");
    expect(recordPing).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith("lock:rem:k");
  });

  it("аренда протухает с запасом больше прогона, но не на часы", () => {
    expect(LEASE_TTL_MS).toBeGreaterThanOrEqual(60000);
    expect(LEASE_TTL_MS).toBeLessThanOrEqual(10 * 60000);
  });
});
