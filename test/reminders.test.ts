// Напоминание о занятии в человеческое время: утреннее занятие — накануне в 19:00,
// дневное и вечернее — в тот же день в 10:00. Проверяем и сам выбор момента, и то,
// что опоздавший крон не пишет ночью.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENING_HOUR_MSK,
  LATE_CUTOFF_HOURS,
  MORNING_HOUR_MSK,
  mskHour,
  reminderMomentFor,
  sendLessonReminders,
} from "@/lib/reminders";
import { listDayOccurrences } from "@/lib/google";
import { getStudent } from "@/lib/students";
import { notifyStudent } from "@/lib/notify";
import { pingSent, recordPing } from "@/lib/pings";

vi.mock("@/lib/google", () => ({ listDayOccurrences: vi.fn(async () => []) }));
vi.mock("@/lib/students", () => ({ getStudent: vi.fn(async () => null) }));
vi.mock("@/lib/notify", () => ({ notifyStudent: vi.fn(async () => {}) }));
vi.mock("@/lib/pings", () => ({
  pingSent: vi.fn(async () => false),
  recordPing: vi.fn(async () => {}),
}));

// МСК = UTC+3.
const msk = (iso: string) => new Date(`${iso}+03:00`);
const STUDENT = { id: "stu-1", name: "Стас", tgChatId: "777" };

function occ(start: Date, over: Record<string, unknown> = {}) {
  return {
    instanceId: `i-${start.toISOString()}`,
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

const text = () => String(vi.mocked(notifyStudent).mock.calls[0]?.[1] ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listDayOccurrences).mockResolvedValue([]);
  vi.mocked(getStudent).mockResolvedValue(STUDENT as never);
  vi.mocked(pingSent).mockResolvedValue(false);
});

describe("reminderMomentFor — когда напоминать", () => {
  it("утреннее занятие (09:00) — накануне в 19:00 МСК", () => {
    const at = reminderMomentFor(msk("2026-07-15T09:00:00"));
    expect(mskHour(at)).toBe(EVENING_HOUR_MSK);
    expect(at.toISOString()).toBe(msk("2026-07-14T19:00:00").toISOString());
  });

  it("занятие ровно в 12:00 — уже не «утреннее», напоминаем в тот же день в 10:00", () => {
    const at = reminderMomentFor(msk("2026-07-15T12:00:00"));
    expect(mskHour(at)).toBe(MORNING_HOUR_MSK);
    expect(at.toISOString()).toBe(msk("2026-07-15T10:00:00").toISOString());
  });

  it("вечернее занятие (20:00) — в тот же день в 10:00", () => {
    expect(reminderMomentFor(msk("2026-07-15T20:00:00")).toISOString()).toBe(
      msk("2026-07-15T10:00:00").toISOString()
    );
  });

  it("занятие в 11:59 — ещё «утреннее», напоминаем накануне", () => {
    expect(reminderMomentFor(msk("2026-07-15T11:59:00")).toISOString()).toBe(
      msk("2026-07-14T19:00:00").toISOString()
    );
  });
});

describe("sendLessonReminders", () => {
  it("вечером накануне — про завтрашнее утреннее занятие", async () => {
    const now = msk("2026-07-14T19:02:00");
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(msk("2026-07-15T09:00:00"))] as never);

    expect(await sendLessonReminders(now)).toEqual({ reminders: 1 });
    expect(text()).toContain("завтра занятие в <b>09:00</b>");
  });

  it("утром — про сегодняшнее вечернее занятие", async () => {
    const now = msk("2026-07-15T10:01:00");
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(msk("2026-07-15T18:30:00"))] as never);

    expect(await sendLessonReminders(now)).toEqual({ reminders: 1 });
    expect(text()).toContain("сегодня занятие в <b>18:30</b>");
  });

  it("до нужного часа молчим: в 15:00 про завтрашнее утро ещё рано", async () => {
    const now = msk("2026-07-14T15:00:00");
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(msk("2026-07-15T09:00:00"))] as never);

    expect(await sendLessonReminders(now)).toEqual({ reminders: 0 });
    expect(notifyStudent).not.toHaveBeenCalled();
  });

  it("крон проспал до ночи — не пишем вовсе, чтобы не будить", async () => {
    // Нужно было в 19:00, а прогон случился в 23:30 — позже отсечки.
    const now = msk("2026-07-14T23:30:00");
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(msk("2026-07-15T09:00:00"))] as never);

    expect(await sendLessonReminders(now)).toEqual({ reminders: 0 });
    expect(notifyStudent).not.toHaveBeenCalled();
  });

  it("небольшое опоздание внутри отсечки — напоминание всё же уходит", async () => {
    const now = new Date(
      msk("2026-07-14T19:00:00").getTime() + (LATE_CUTOFF_HOURS * 3600000 - 60000)
    );
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(msk("2026-07-15T09:00:00"))] as never);
    expect(await sendLessonReminders(now)).toEqual({ reminders: 1 });
  });

  it("два занятия в один день — одно сообщение с обоими временами", async () => {
    const now = msk("2026-07-15T10:01:00");
    vi.mocked(listDayOccurrences).mockResolvedValue([
      occ(msk("2026-07-15T16:00:00")),
      occ(msk("2026-07-15T18:30:00")),
    ] as never);

    expect(await sendLessonReminders(now)).toEqual({ reminders: 1 });
    expect(notifyStudent).toHaveBeenCalledOnce();
    expect(text()).toContain("занятия в <b>16:00, 18:30</b>");
  });

  it("повторно не напоминаем", async () => {
    const now = msk("2026-07-15T10:01:00");
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(msk("2026-07-15T18:30:00"))] as never);
    vi.mocked(pingSent).mockResolvedValue(true);

    expect(await sendLessonReminders(now)).toEqual({ reminders: 0 });
    expect(notifyStudent).not.toHaveBeenCalled();
    expect(recordPing).not.toHaveBeenCalled();
  });

  it("ученик не подключил уведомления — ничего не шлём", async () => {
    const now = msk("2026-07-15T10:01:00");
    vi.mocked(listDayOccurrences).mockResolvedValue([occ(msk("2026-07-15T18:30:00"))] as never);
    vi.mocked(getStudent).mockResolvedValue({ ...STUDENT, tgChatId: "" } as never);

    expect(await sendLessonReminders(now)).toEqual({ reminders: 0 });
    expect(notifyStudent).not.toHaveBeenCalled();
  });

  it("уже начавшееся и помеченное пропуском занятие не напоминаем", async () => {
    const now = msk("2026-07-15T10:01:00");
    vi.mocked(listDayOccurrences).mockResolvedValue([
      occ(msk("2026-07-15T09:00:00")), // уже прошло
      occ(msk("2026-07-15T18:30:00"), { colorId: "8" }), // пропуск
    ] as never);

    expect(await sendLessonReminders(now)).toEqual({ reminders: 0 });
  });
});
