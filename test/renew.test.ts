// Продление серий: RRULE-арифметика (чистая) и напоминание «занятия скоро
// закончатся» с дедупликацией по lesson_pings.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extendRrule } from "@/lib/google";
import { findEndingSeries, sendRenewalPrompts } from "@/lib/renew";
import { lastOccurrenceOf, listSeriesMasters } from "@/lib/google";
import { pingSent, recordPing } from "@/lib/pings";
import { sendOwner } from "@/lib/telegram";

vi.mock("@/lib/google", async (importOriginal) => {
  // extendRrule — чистая функция, её берём настоящую; хождения в календарь глушим.
  const actual = await importOriginal<typeof import("@/lib/google")>();
  return {
    extendRrule: actual.extendRrule,
    listSeriesMasters: vi.fn(async () => []),
    lastOccurrenceOf: vi.fn(async () => null),
  };
});
vi.mock("@/lib/pings", () => ({
  pingSent: vi.fn(async () => false),
  recordPing: vi.fn(async () => {}),
}));
vi.mock("@/lib/telegram", () => ({
  sendOwner: vi.fn(async () => {}),
  escapeHtml: (s: string) => s,
  inlineKeyboard: (rows: { text: string; data: string }[][]) => ({
    inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))),
  }),
}));

const NOW = new Date("2026-07-14T09:00:00.000Z");

const master = (over: Record<string, unknown> = {}) => ({
  id: "ev1",
  student: "Тест Тестов",
  studentId: "stu-1",
  subject: "Питон",
  start: new Date("2026-01-13T07:00:00.000Z"),
  rrule: "RRULE:FREQ=WEEKLY;COUNT=26",
  finite: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSeriesMasters).mockResolvedValue([]);
  vi.mocked(pingSent).mockResolvedValue(false);
});

describe("extendRrule — продление правила повтора", () => {
  it("COUNT увеличивается на число недель (FREQ=WEEKLY: повтор = неделя)", () => {
    expect(extendRrule("RRULE:FREQ=WEEKLY;COUNT=26", 26)).toBe("RRULE:FREQ=WEEKLY;COUNT=52");
  });

  it("UNTIL сдвигается на нужное число недель", () => {
    expect(extendRrule("RRULE:FREQ=WEEKLY;UNTIL=20260714T090000Z", 2)).toBe(
      "RRULE:FREQ=WEEKLY;UNTIL=20260728T090000Z"
    );
  });

  it("бессрочное правило продлевать нечего — null", () => {
    expect(extendRrule("RRULE:FREQ=WEEKLY", 26)).toBeNull();
  });

  it("остальные части правила не трогаются", () => {
    expect(extendRrule("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4", 1)).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=5"
    );
  });
});

describe("findEndingSeries — какие серии скоро закончатся", () => {
  it("последнее занятие в пределах окна — серия попадает в список", async () => {
    vi.mocked(listSeriesMasters).mockResolvedValue([master()] as any);
    vi.mocked(lastOccurrenceOf).mockResolvedValue("2026-07-28T07:00:00.000Z"); // через 14 дней

    const list = await findEndingSeries(NOW);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ eventId: "ev1", student: "Тест Тестов" });
    expect(list[0].slot).toContain("вторник"); // 13 января 2026 — вторник
  });

  it("до конца ещё далеко — не беспокоим", async () => {
    vi.mocked(listSeriesMasters).mockResolvedValue([master()] as any);
    vi.mocked(lastOccurrenceOf).mockResolvedValue("2026-10-01T07:00:00.000Z");

    expect(await findEndingSeries(NOW)).toHaveLength(0);
  });

  it("бессрочная серия и серия без будущих занятий пропускаются", async () => {
    vi.mocked(listSeriesMasters).mockResolvedValue([
      master({ finite: false }),
      master({ id: "ev2" }),
    ] as any);
    vi.mocked(lastOccurrenceOf).mockResolvedValue(null); // будущих наступлений нет

    expect(await findEndingSeries(NOW)).toHaveLength(0);
  });
});

describe("sendRenewalPrompts — вопрос владельцу", () => {
  beforeEach(() => {
    vi.mocked(listSeriesMasters).mockResolvedValue([master()] as any);
    vi.mocked(lastOccurrenceOf).mockResolvedValue("2026-07-28T07:00:00.000Z");
  });

  it("шлёт сообщение с кнопкой продления и отмечает отправку", async () => {
    expect(await sendRenewalPrompts(NOW)).toEqual({ asked: 1 });

    const [text, keyboard] = vi.mocked(sendOwner).mock.calls[0] as any;
    expect(text).toContain("Занятия скоро закончатся");
    expect(text).toContain("28 июля");
    expect(JSON.stringify(keyboard)).toContain("renew:ev1");
    // Ключ дедупликации включает дату конца — после продления спросим снова.
    expect(recordPing).toHaveBeenCalledWith("renew:ev1:2026-07-28");
  });

  it("про этот же конец серии уже спрашивали — молчим", async () => {
    vi.mocked(pingSent).mockResolvedValue(true);
    expect(await sendRenewalPrompts(NOW)).toEqual({ asked: 0 });
    expect(sendOwner).not.toHaveBeenCalled();
  });
});
