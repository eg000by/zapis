// Закреп в чате ученика при подключении уведомлений: кабинет, Телемост и контакт
// преподавателя. Раньше эта функция была во всех тестах замокана целиком — её
// содержимое не проверял никто.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pinStudentLinks } from "@/lib/notify";
import { pinChatMessage, sendTo } from "@/lib/telegram";
import { listContactEvents } from "@/lib/google";
import { getGroup } from "@/lib/groups";

vi.mock("@/lib/telegram", () => ({
  sendTo: vi.fn(async () => ({ message_id: 42 })),
  pinChatMessage: vi.fn(async () => {}),
}));
vi.mock("@/lib/students", () => ({ getStudent: vi.fn(async () => null) }));
vi.mock("@/lib/google", () => ({
  listContactEvents: vi.fn(async () => [{ status: "confirmed" }]),
}));
vi.mock("@/lib/groups", () => ({ getGroup: vi.fn(async () => null) }));
vi.mock("@/lib/shortlink", () => ({
  getOrCreateStudentLinkCode: vi.fn(async () => "abc123"),
}));

const STUDENT = {
  id: "stu-1",
  trial: false,
  meetLink: "https://telemost.yandex.ru/j/777",
  boardLink: "https://unidraw.io/app/board/abc",
  contactKey: "key-1",
  groupId: null,
};
const text = () => String(vi.mocked(sendTo).mock.calls[0]?.[1] ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listContactEvents).mockResolvedValue([{ status: "confirmed" }] as never);
  process.env.NEXT_PUBLIC_BASE_URL = "https://zapis-ten.vercel.app";
});

describe("pinStudentLinks", () => {
  it("закрепляет кабинет, звонок, доску и контакт преподавателя", async () => {
    await pinStudentLinks(STUDENT, 555);

    const t = text();
    expect(t).toContain("https://zapis-ten.vercel.app/z/abc123");
    expect(t).toContain("https://telemost.yandex.ru/j/777");
    // Доска — такая же рабочая ссылка, как звонок: в закрепе нужны обе.
    expect(t).toContain("https://unidraw.io/app/board/abc");
    expect(t).toContain("https://t.me/eg0by");
    expect(pinChatMessage).toHaveBeenCalledWith(555, 42);
  });

  it("без рабочих ссылок сообщение всё равно уходит — с кабинетом и контактом", async () => {
    await pinStudentLinks({ ...STUDENT, meetLink: "", boardLink: "" }, 555);

    expect(text()).toContain("/z/abc123");
    expect(text()).toContain("https://t.me/eg0by");
    expect(text()).not.toContain("Подключиться");
    expect(text()).not.toContain("Доска");
  });

  // Кнопка подключения видна уже с первой заявкой: /start не должен обходить гейт
  // кабинета и раздавать постоянные ссылки занятия до подтверждения.
  it("только заявка, без подтверждённых занятий — звонка и доски в закрепе нет", async () => {
    vi.mocked(listContactEvents).mockResolvedValueOnce([{ status: "pending" }] as never);
    await pinStudentLinks(STUDENT, 555);

    expect(listContactEvents).toHaveBeenCalledWith("key-1", expect.any(String));
    expect(text()).toContain("/z/abc123"); // кабинет — можно, он и так у ученика
    expect(text()).not.toContain("telemost");
    expect(text()).not.toContain("unidraw");
  });

  it("календарь недоступен — ссылки занятия не отдаём", async () => {
    vi.mocked(listContactEvents).mockRejectedValueOnce(new Error("Google 503"));
    await pinStudentLinks(STUDENT, 555);
    expect(text()).not.toContain("telemost");
    expect(sendTo).toHaveBeenCalledOnce(); // закреп всё равно уходит
  });

  it("участник группы: подтверждённость смотрим по ключу группы", async () => {
    vi.mocked(getGroup).mockResolvedValueOnce({ id: "g1", contactKey: "grp-key" } as never);
    await pinStudentLinks({ ...STUDENT, groupId: "g1" }, 555);
    expect(listContactEvents).toHaveBeenCalledWith("grp-key", expect.any(String));
    expect(text()).toContain("telemost");
  });

  it("сбой закрепа не ломает подключение уведомлений", async () => {
    vi.mocked(pinChatMessage).mockRejectedValueOnce(new Error("нет прав"));
    await expect(pinStudentLinks(STUDENT, 555)).resolves.toBeUndefined();
    expect(sendTo).toHaveBeenCalledOnce();
  });
});
