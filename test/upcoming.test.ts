// «Скоро занятие»: преподавателю — со ссылкой на Телемост и итогом прошлого занятия,
// ученику — то же напоминание, если он подключил уведомления. Одним прогоном, чтобы
// обе стороны узнавали одновременно.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendUpcomingLessonAlerts, UPCOMING_LEAD_MINUTES } from "@/lib/upcoming";
import { listDayOccurrences } from "@/lib/google";
import { getStudent } from "@/lib/students";
import { listStudentLessons } from "@/lib/lessons";
import { pingSent, recordPing } from "@/lib/pings";
import { notifyStudent } from "@/lib/notify";
import { sendOwner } from "@/lib/telegram";

vi.mock("@/lib/google", () => ({ listDayOccurrences: vi.fn(async () => []) }));
vi.mock("@/lib/students", () => ({ getStudent: vi.fn(async () => null) }));
vi.mock("@/lib/lessons", () => ({ listStudentLessons: vi.fn(async () => []) }));
vi.mock("@/lib/pings", () => ({
  pingSent: vi.fn(async () => false),
  recordPing: vi.fn(async () => {}),
}));
vi.mock("@/lib/notify", () => ({ notifyStudent: vi.fn(async () => {}) }));
vi.mock("@/lib/telegram", () => ({
  sendOwner: vi.fn(async () => {}),
  escapeHtml: (s: string) => s,
}));

// «Сейчас» — 12:00 МСК. Занятие в 12:30 МСК попадает в окно (60 минут).
const NOW = new Date("2026-07-12T09:00:00.000Z");
const SOON = new Date("2026-07-12T09:30:00.000Z");

const STUDENT = {
  id: "stu-1",
  name: "Стас",
  meetLink: "https://telemost.yandex.ru/j/777",
  tgChatId: "",
};

function occ(start: Date, over: Record<string, unknown> = {}) {
  return {
    instanceId: "ev1_a",
    start,
    hours: 1,
    colorId: null,
    student: "Стас",
    subject: "Питон",
    studentId: "stu-1",
    contactKey: "key",
    ...over,
  };
}

const ownerText = () => String(vi.mocked(sendOwner).mock.calls[0]?.[0] ?? "");
const studentText = () => String(vi.mocked(notifyStudent).mock.calls[0]?.[1] ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  vi.mocked(listDayOccurrences).mockResolvedValue([]);
  vi.mocked(pingSent).mockResolvedValue(false);
  vi.mocked(getStudent).mockResolvedValue(STUDENT as never);
  vi.mocked(listStudentLessons).mockResolvedValue([]);
});

describe("sendUpcomingLessonAlerts", () => {
  it("преподавателю: время, ссылка на Телемост и итог прошлого занятия", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(SOON)] as never);
    vi.mocked(listStudentLessons).mockResolvedValue([
      { id: "l1", note: "разбирали словари", occurrenceStart: new Date("2026-07-05T09:30:00.000Z") },
    ] as never);

    expect(await sendUpcomingLessonAlerts(NOW)).toEqual({ sent: 1 });

    const t = ownerText();
    expect(t).toContain("Скоро занятие");
    expect(t).toContain("Стас");
    expect(t).toContain("https://telemost.yandex.ru/j/777");
    expect(t).toContain("Прошлое занятие (05.07): разбирали словари");
    expect(recordPing).toHaveBeenCalledWith("soon:ev1_a");
  });

  it("ссылки на Телемост нет — прямо говорим об этом, а не молчим", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(SOON)] as never);
    vi.mocked(getStudent).mockResolvedValue({ ...STUDENT, meetLink: "" } as never);

    await sendUpcomingLessonAlerts(NOW);
    expect(ownerText()).toContain("Ссылка на Телемост не задана");
  });

  it("прошлых занятий не было — так и пишем", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(SOON)] as never);
    await sendUpcomingLessonAlerts(NOW);
    expect(ownerText()).toContain("это первое");
  });

  it("заметки к прошлому занятию нет — сообщаем дату без выдумок", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(SOON)] as never);
    vi.mocked(listStudentLessons).mockResolvedValue([
      { id: "l1", note: "", occurrenceStart: new Date("2026-07-05T09:30:00.000Z") },
    ] as never);

    await sendUpcomingLessonAlerts(NOW);
    expect(ownerText()).toContain("Прошлое занятие (05.07): заметки нет");
  });

  it("будущие занятия за прошлое не считаются", async () => {
    // occurrenceStart позже «сейчас» — это следующая запись, а не прошлая.
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(SOON)] as never);
    vi.mocked(listStudentLessons).mockResolvedValue([
      { id: "l2", note: "ещё не было", occurrenceStart: new Date("2026-07-19T09:30:00.000Z") },
    ] as never);

    await sendUpcomingLessonAlerts(NOW);
    expect(ownerText()).toContain("это первое");
    expect(ownerText()).not.toContain("ещё не было");
  });

  it("ученику с подключёнными уведомлениями — то же напоминание и та же ссылка", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(SOON)] as never);
    vi.mocked(getStudent).mockResolvedValue({ ...STUDENT, tgChatId: "555" } as never);

    await sendUpcomingLessonAlerts(NOW);
    expect(notifyStudent).toHaveBeenCalledOnce();
    const t = studentText();
    // Сколько осталось — не пишем: крон может прийти раньше или позже.
    expect(t).not.toMatch(/через \d+ мин/i);
    expect(t).toContain("Начало в 12:30");
    expect(t).toContain("https://telemost.yandex.ru/j/777");
    expect(t).toContain("t.me/eg0by"); // контакт преподавателя
  });

  it("ученик не подключил уведомления — пишем только преподавателю", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(SOON)] as never);
    await sendUpcomingLessonAlerts(NOW);
    expect(sendOwner).toHaveBeenCalledOnce();
    expect(notifyStudent).not.toHaveBeenCalled();
  });

  it("уже предупреждали — второй раз не пишем", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(SOON)] as never);
    vi.mocked(pingSent).mockResolvedValue(true);

    expect(await sendUpcomingLessonAlerts(NOW)).toEqual({ sent: 0 });
    expect(sendOwner).not.toHaveBeenCalled();
  });

  it("уже начавшееся занятие в «предстоящие» не попадает", async () => {
    // Google отдаёт всё, что пересекает окно, включая идущее занятие.
    vi.mocked(listDayOccurrences).mockResolvedValue([
      occ(new Date(NOW.getTime() - 10 * 60000)),
    ] as never);

    expect(await sendUpcomingLessonAlerts(NOW)).toEqual({ sent: 0 });
    expect(sendOwner).not.toHaveBeenCalled();
  });

  it("помеченное пропуском занятие не напоминаем", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(SOON, { colorId: "8" })] as never);
    expect(await sendUpcomingLessonAlerts(NOW)).toEqual({ sent: 0 });
  });

  it("сбой по одному занятию не срывает остальные", async () => {
    vi.mocked(listDayOccurrences).mockResolvedValue([
      occ(SOON),
      occ(SOON, { instanceId: "ev1_b", studentId: "stu-2" }),
    ] as never);
    vi.mocked(sendOwner).mockRejectedValueOnce(new Error("Telegram недоступен"));

    expect(await sendUpcomingLessonAlerts(NOW)).toEqual({ sent: 1 });
  });

  it("предупреждаем примерно за час, а не за полдня", async () => {
    // Окно было временно расширено до 3 часов, пока единственным планировщиком был
    // GitHub с промежутками до 3 часов между прогонами (30 июля занятие в 10:10
    // осталось вообще без уведомления). С внешним пингером каждые 5 минут запас не
    // нужен: за три часа предупреждать рано.
    const soon = new Date(NOW.getTime() + 55 * 60000);
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(soon)] as never);
    expect(await sendUpcomingLessonAlerts(NOW)).toEqual({ sent: 1 });

    // Отсев дальних занятий делает сам запрос к календарю: занятие через полтора
    // часа за границу timeMax не попадает.
    const [, to] = vi.mocked(listDayOccurrences).mock.calls[0];
    expect(NOW.getTime() + 90 * 60000).toBeGreaterThan(to.getTime());
    expect(soon.getTime()).toBeLessThanOrEqual(to.getTime());
  });

  it("окно запроса к календарю — ровно на UPCOMING_LEAD_MINUTES вперёд", async () => {
    await sendUpcomingLessonAlerts(NOW);
    const [from, to] = vi.mocked(listDayOccurrences).mock.calls[0];
    expect(from.getTime()).toBe(NOW.getTime());
    expect(to.getTime() - from.getTime()).toBe(UPCOMING_LEAD_MINUTES * 60000);
  });
});
