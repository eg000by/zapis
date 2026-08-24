// Группа: одно занятие в календаре на четверых, деньги и кабинет у каждого свои.
// Проверяем именно связки, которые легко разъезжаются: откуда берётся расписание
// участника, по какой цене считается его баланс и кого касается занятие группы.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeStudentBalance } from "@/lib/balance";
import { recolorStudent } from "@/lib/coloring";
import { listContactOccurrences, setEventColor } from "@/lib/google";
import { getStudent } from "@/lib/students";
import { getGroup } from "@/lib/groups";
import { sumPaidKopecks } from "@/lib/payments";
import { missedStarts } from "@/lib/lessons";

vi.mock("@/lib/google", () => ({
  CALENDAR_ID: "cal",
  calendarClient: vi.fn(),
  listContactMasters: vi.fn(async () => []),
  listContactOccurrences: vi.fn(async () => []),
  setEventColor: vi.fn(async () => {}),
  deleteFutureEventsForContact: vi.fn(async () => 0),
  applyMeetLinkToEvents: vi.fn(async () => 0),
}));
vi.mock("@/lib/students", () => ({ getStudent: vi.fn() }));
// Посещаемость участника группы (пропуски) — своя ветка, проверяется ниже отдельно.
vi.mock("@/lib/lessons", () => ({ missedStarts: vi.fn(async () => new Set<string>()) }));
vi.mock("@/lib/groups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/groups")>();
  return { ...actual, getGroup: vi.fn(), activeMembers: vi.fn(async () => []) };
});
vi.mock("@/lib/payments", () => {
  const sumPaidKopecks = vi.fn(async () => 0);
  return {
    sumPaidKopecks,
    paidHoursBreakdown: vi.fn(async (id: string, rate: number) => {
      const money = await sumPaidKopecks();
      return {
        paidHours: rate > 0 ? Math.floor(money / rate) : 0,
        moneyKopecks: money,
        packageHours: 0,
        packageKopecks: 0,
      };
    }),
  };
});

const NOW = new Date("2026-08-24T09:00:00.000Z");
const PAST = "2026-08-22T13:00:00.000Z";
const FUT = "2026-08-29T13:00:00.000Z";

const GROUP = {
  id: "grp-1",
  name: "ОГЭ, суббота",
  subject: "ОГЭ информатика",
  contactKey: "group-key",
  rateKopecks: 75000, // 750 ₽ за занятие с каждого
  meetLink: "https://telemost.yandex.ru/j/group",
  active: true,
};
// Личная ставка у участника осталась прежней (1500 ₽) — в группе она не при делах.
const MEMBER = {
  id: "stu-1",
  name: "Егор",
  subject: "ОГЭ информатика",
  contactKey: "personal-key",
  rateKopecks: 150000,
  groupId: "grp-1",
  trial: false,
  active: true,
};

const occ = (startIso: string) => ({
  instanceId: `i-${startIso}`,
  start: new Date(startIso),
  hours: 1,
  colorId: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  vi.mocked(getStudent).mockResolvedValue(MEMBER as never);
  vi.mocked(getGroup).mockResolvedValue(GROUP as never);
  vi.mocked(sumPaidKopecks).mockResolvedValue(0);
  vi.mocked(listContactOccurrences).mockResolvedValue([]);
  vi.mocked(missedStarts).mockResolvedValue(new Set());
});

describe("баланс участника группы", () => {
  it("расписание берётся у группы, а не у ученика", async () => {
    await computeStudentBalance("stu-1");
    expect(listContactOccurrences).toHaveBeenCalledWith("group-key");
    expect(listContactOccurrences).not.toHaveBeenCalledWith("personal-key");
  });

  it("считается по цене группы, личная ставка не участвует", async () => {
    vi.mocked(listContactOccurrences).mockResolvedValue([occ(PAST), occ(FUT)] as never);
    vi.mocked(sumPaidKopecks).mockResolvedValue(75000); // одно занятие в группе

    const b = (await computeStudentBalance("stu-1"))!;
    expect(b.rateKopecks).toBe(75000);
    // Оплаченного хватило ровно на прошедшее занятие; будущее — долгом не считается.
    expect(b).toMatchObject({ paidHours: 1, debtHours: 0, debtKopecks: 0, aheadHours: 0 });
    expect(b.nextStart).toBe(FUT);
    expect(b.nextPaid).toBe(false);
  });

  it("долг считается по цене группы", async () => {
    vi.mocked(listContactOccurrences).mockResolvedValue([occ(PAST)] as never);
    const b = (await computeStudentBalance("stu-1"))!;
    expect(b.debtHours).toBe(1);
    expect(b.debtKopecks).toBe(75000); // 750 ₽, а не 1500 ₽ личной ставки
  });

  it("цена группы не задана — баланса нет (ложный долг не показываем)", async () => {
    vi.mocked(getGroup).mockResolvedValue({ ...GROUP, rateKopecks: 0 } as never);
    vi.mocked(listContactOccurrences).mockResolvedValue([occ(PAST)] as never);
    expect(await computeStudentBalance("stu-1")).toBeNull();
  });
});

describe("посещаемость", () => {
  it("пропущенное участником занятие не тарифицируется ЕМУ одному", async () => {
    // Занятие в календаре одно на всех и остаётся нетронутым: пропуск персональный.
    vi.mocked(listContactOccurrences).mockResolvedValue([occ(PAST), occ(FUT)] as never);
    vi.mocked(missedStarts).mockResolvedValue(new Set([PAST]));

    const b = (await computeStudentBalance("stu-1"))!;
    expect(b.debtHours).toBe(0); // прошедшее занятие пропущено — долга нет
    expect(b.items.map((i) => i.start.toISOString())).toEqual([FUT]);
  });

  it("пропуски спрашиваются только по участникам группы", async () => {
    vi.mocked(getStudent).mockResolvedValue({ ...MEMBER, groupId: null } as never);
    await computeStudentBalance("stu-1");
    // У индивидуального занятия пропуск отмечается серым цветом события.
    expect(missedStarts).not.toHaveBeenCalled();
  });
});

describe("покраска", () => {
  it("групповые занятия не красятся: у четверых оплата разная", async () => {
    vi.mocked(listContactOccurrences).mockResolvedValue([occ(PAST)] as never);
    await recolorStudent("stu-1");
    // Прошедшее неоплаченное занятие обычного ученика стало бы красным.
    expect(setEventColor).not.toHaveBeenCalled();
  });
});
