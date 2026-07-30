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

  it("окно шире промежутка между прогонами крона (случай 30 июля)", async () => {
    // Реальный сбой: пульс отработал в 07:20 МСК, следующий раз — в 10:11, а занятие
    // начиналось в 10:10. С часовым окном оно целиком провалилось в промежуток и
    // уведомления не было вовсе. Окно должно перекрывать такой простой.
    const run = new Date("2026-07-30T04:20:00.000Z"); // 07:20 МСК
    const lesson = new Date("2026-07-30T07:10:00.000Z"); // 10:10 МСК
    expect(lesson.getTime() - run.getTime()).toBeLessThanOrEqual(
      UPCOMING_LEAD_MINUTES * 60000
    );

    vi.setSystemTime(run);
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(lesson)] as never);
    expect(await sendUpcomingLessonAlerts(run)).toEqual({ sent: 1 });
    expect(ownerText()).toContain("Скоро занятие");
  });

  it("окно запроса к календарю — ровно на UPCOMING_LEAD_MINUTES вперёд", async () => {
    await sendUpcomingLessonAlerts(NOW);
    const [from, to] = vi.mocked(listDayOccurrences).mock.calls[0];
    expect(from.getTime()).toBe(NOW.getTime());
    expect(to.getTime() - from.getTime()).toBe(UPCOMING_LEAD_MINUTES * 60000);
  });
});
