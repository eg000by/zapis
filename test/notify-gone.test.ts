// Ученик заблокировал бота: Telegram отказывает, а кабинет продолжал бы показывать
// «уведомления подключены» и прятать кнопку переподключения. Такой чат отвязываем.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyStudent } from "@/lib/notify";
import { sendMessageRaw } from "@/lib/telegram";
import { clearTgChat } from "@/lib/students";

vi.mock("@/lib/telegram", async (importOriginal) => ({
  isChatGone: (await importOriginal<typeof import("@/lib/telegram")>()).isChatGone,
  sendMessageRaw: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendTo: vi.fn(async () => null),
  pinChatMessage: vi.fn(async () => {}),
}));
vi.mock("@/lib/students", () => ({
  getStudent: vi.fn(async () => null),
  clearTgChat: vi.fn(async () => {}),
}));
vi.mock("@/lib/google", () => ({ listContactEvents: vi.fn(async () => []) }));
vi.mock("@/lib/groups", () => ({ getGroup: vi.fn(async () => null) }));
vi.mock("@/lib/shortlink", () => ({ getOrCreateStudentLinkCode: vi.fn(async () => "x") }));

const STUDENT = { tgChatId: "555" };

beforeEach(() => vi.clearAllMocks());

describe("notifyStudent — недоступный чат", () => {
  it("доставлено — привязку не трогаем", async () => {
    expect(await notifyStudent(STUDENT, "привет")).toBe(true);
    expect(sendMessageRaw).toHaveBeenCalledWith("555", "привет");
    expect(clearTgChat).not.toHaveBeenCalled();
  });

  it("бот заблокирован (403) — отвязываем чат", async () => {
    vi.mocked(sendMessageRaw).mockResolvedValueOnce({
      ok: false,
      error_code: 403,
      description: "Forbidden: bot was blocked by the user",
    });
    expect(await notifyStudent(STUDENT, "привет")).toBe(false);
    expect(clearTgChat).toHaveBeenCalledWith("555");
  });

  it("чата больше нет — тоже отвязываем", async () => {
    vi.mocked(sendMessageRaw).mockResolvedValueOnce({
      ok: false,
      error_code: 400,
      description: "Bad Request: chat not found",
    });
    await notifyStudent(STUDENT, "привет");
    expect(clearTgChat).toHaveBeenCalledWith("555");
  });

  it("временная ошибка (429, кривой HTML) — привязку оставляем", async () => {
    vi.mocked(sendMessageRaw).mockResolvedValueOnce({
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 5",
    });
    await notifyStudent(STUDENT, "привет");
    vi.mocked(sendMessageRaw).mockResolvedValueOnce({
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities",
    });
    await notifyStudent(STUDENT, "привет");
    expect(clearTgChat).not.toHaveBeenCalled();
  });

  it("сбой сети не роняет вызывающего", async () => {
    vi.mocked(sendMessageRaw).mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(notifyStudent(STUDENT, "привет")).resolves.toBe(false);
    expect(clearTgChat).not.toHaveBeenCalled();
  });
});
