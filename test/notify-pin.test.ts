// Закреп в чате ученика при подключении уведомлений: кабинет, Телемост и контакт
// преподавателя. Раньше эта функция была во всех тестах замокана целиком — её
// содержимое не проверял никто.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pinStudentLinks } from "@/lib/notify";
import { pinChatMessage, sendTo } from "@/lib/telegram";

vi.mock("@/lib/telegram", () => ({
  sendTo: vi.fn(async () => ({ message_id: 42 })),
  pinChatMessage: vi.fn(async () => {}),
}));
vi.mock("@/lib/students", () => ({ getStudent: vi.fn(async () => null) }));
vi.mock("@/lib/shortlink", () => ({
  getOrCreateStudentLinkCode: vi.fn(async () => "abc123"),
}));

const STUDENT = { id: "stu-1", trial: false, meetLink: "https://telemost.yandex.ru/j/777" };
const text = () => String(vi.mocked(sendTo).mock.calls[0]?.[1] ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_BASE_URL = "https://zapis-ten.vercel.app";
});

describe("pinStudentLinks", () => {
  it("закрепляет кабинет, Телемост и контакт преподавателя", async () => {
    await pinStudentLinks(STUDENT, 555);

    const t = text();
    expect(t).toContain("https://zapis-ten.vercel.app/z/abc123");
    expect(t).toContain("https://telemost.yandex.ru/j/777");
    expect(t).toContain("https://t.me/eg0by");
    expect(pinChatMessage).toHaveBeenCalledWith(555, 42);
  });

  it("без ссылки на Телемост сообщение всё равно уходит — с кабинетом и контактом", async () => {
    await pinStudentLinks({ ...STUDENT, meetLink: "" }, 555);

    expect(text()).toContain("/z/abc123");
    expect(text()).toContain("https://t.me/eg0by");
    expect(text()).not.toContain("Телемост");
  });

  it("сбой закрепа не ломает подключение уведомлений", async () => {
    vi.mocked(pinChatMessage).mockRejectedValueOnce(new Error("нет прав"));
    await expect(pinStudentLinks(STUDENT, 555)).resolves.toBeUndefined();
    expect(sendTo).toHaveBeenCalledOnce();
  });
});
