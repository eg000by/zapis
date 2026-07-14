import { beforeEach, describe, expect, it, vi } from "vitest";
import { allocateBalance, computeStudentBalance } from "@/lib/balance";
import { listContactOccurrences } from "@/lib/google";
import { getStudent } from "@/lib/students";
import { sumPaidKopecks } from "@/lib/payments";

vi.mock("@/lib/google", () => ({ listContactOccurrences: vi.fn(async () => []) }));
vi.mock("@/lib/students", () => ({ getStudent: vi.fn(async () => null) }));
vi.mock("@/lib/payments", () => ({ sumPaidKopecks: vi.fn(async () => 0) }));

const NOW = new Date("2026-07-12T09:00:00.000Z");

function occ(startIso: string, hours = 1) {
  return { instanceId: `i-${startIso}`, start: new Date(startIso), hours, colorId: null };
}

const PAST1 = "2026-07-01T15:10:00.000Z";
const PAST2 = "2026-07-08T15:10:00.000Z";
const FUT1 = "2026-07-14T15:10:00.000Z";
const FUT2 = "2026-07-21T15:10:00.000Z";

describe("allocateBalance — раскладка оплаченных часов по занятиям", () => {
  it("закрывает занятия с самых ранних: прошлое → будущее, paidUntil — последнее закрытое", () => {
    const { items, summary } = allocateBalance([occ(PAST1), occ(PAST2), occ(FUT1), occ(FUT2)], 3, NOW);
    expect(items.map((i) => i.paid)).toEqual([true, true, true, false]);
    expect(summary).toMatchObject({
      pastPaidHours: 2,
      debtHours: 0,
      aheadHours: 1,
      leftoverHours: 0,
      paidUntil: FUT1,
    });
  });

  it("нехватка на проведённые = долг", () => {
    const { summary } = allocateBalance([occ(PAST1), occ(PAST2), occ(FUT1)], 1, NOW);
    expect(summary).toMatchObject({ pastPaidHours: 1, debtHours: 1, aheadHours: 0, paidUntil: PAST1 });
  });

  it("блок «всё-или-ничего»: не хватило на блок — дальше ничего не закрывается", () => {
    const { items, summary } = allocateBalance([occ(FUT1, 2), occ(FUT2, 1)], 1, NOW);
    expect(items.map((i) => i.paid)).toEqual([false, false]);
    // Остаток остаётся на балансе, а не перескакивает на меньший блок.
    expect(summary).toMatchObject({ aheadHours: 0, leftoverHours: 1, paidUntil: null });
  });

  it("деньги сверх всех занятий — leftoverHours", () => {
    const { summary } = allocateBalance([occ(PAST1), occ(FUT1)], 5, NOW);
    expect(summary).toMatchObject({
      pastPaidHours: 1,
      aheadHours: 1,
      leftoverHours: 3,
      paidUntil: FUT1,
    });
  });

  it("без занятий весь баланс — остаток", () => {
    expect(allocateBalance([], 2, NOW).summary.leftoverHours).toBe(2);
  });
});

describe("computeStudentBalance — баланс в деньгах", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(NOW);
    vi.mocked(getStudent).mockResolvedValue(null);
    vi.mocked(listContactOccurrences).mockResolvedValue([]);
    vi.mocked(sumPaidKopecks).mockResolvedValue(0);
  });

  it("null без ученика или без ставки (не пугаем ложным долгом)", async () => {
    expect(await computeStudentBalance("нет")).toBeNull();
    vi.mocked(getStudent).mockResolvedValue({ id: "s", contactKey: "k", rateKopecks: 0 } as any);
    expect(await computeStudentBalance("s")).toBeNull();
  });

  it("долг и остаток считаются от ставки, хвост от деления — в остаток", async () => {
    vi.mocked(getStudent).mockResolvedValue({ id: "s", contactKey: "k", rateKopecks: 150000 } as any);
    vi.mocked(sumPaidKopecks).mockResolvedValue(500000); // 3 часа + 50 000 коп. хвост
    vi.mocked(listContactOccurrences).mockResolvedValue([
      occ(PAST1), occ(PAST2), occ(FUT1), occ(FUT2),
    ] as any);

    const b = (await computeStudentBalance("s"))!;
    expect(b).toMatchObject({
      paidHours: 3,
      debtHours: 0,
      debtKopecks: 0,
      aheadHours: 1,
      paidUntil: FUT1,
      balanceKopecks: 50000,
    });
  });

  it("проведённые без денег → долг в деньгах", async () => {
    vi.mocked(getStudent).mockResolvedValue({ id: "s", contactKey: "k", rateKopecks: 150000 } as any);
    vi.mocked(listContactOccurrences).mockResolvedValue([occ(PAST1), occ(PAST2, 2)] as any);

    const b = (await computeStudentBalance("s"))!;
    expect(b).toMatchObject({ debtHours: 3, debtKopecks: 450000, balanceKopecks: 0, paidUntil: null });
  });

  it("серое (пропуск) не тарифицируется: ни в долг, ни в списание баланса", async () => {
    vi.mocked(getStudent).mockResolvedValue({ id: "s", contactKey: "k", rateKopecks: 150000 } as any);
    vi.mocked(sumPaidKopecks).mockResolvedValue(150000); // 1 час
    vi.mocked(listContactOccurrences).mockResolvedValue([
      { ...occ(PAST1), colorId: "8" }, // пропущено — не в счёт
      occ(PAST2), // закрывается единственным оплаченным часом
    ] as any);

    const b = (await computeStudentBalance("s"))!;
    expect(b).toMatchObject({ debtHours: 0, debtKopecks: 0, pastPaidHours: 1, paidUntil: PAST2 });
    expect(b.items.map((i) => i.instanceId)).toEqual([`i-${PAST2}`]);
  });

  it("бесплатное пробное (Sage, цвет 2) не висит долгом", async () => {
    vi.mocked(getStudent).mockResolvedValue({ id: "s", contactKey: "k", rateKopecks: 150000 } as any);
    vi.mocked(sumPaidKopecks).mockResolvedValue(0); // ничего не оплачено
    vi.mocked(listContactOccurrences).mockResolvedValue([
      { ...occ(PAST1), colorId: "2" }, // бесплатное пробное — вне тарификации
    ] as any);

    const b = (await computeStudentBalance("s"))!;
    expect(b).toMatchObject({ debtHours: 0, debtKopecks: 0 });
    expect(b.items).toHaveLength(0);
  });
});
