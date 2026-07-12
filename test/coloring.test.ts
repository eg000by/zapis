import { beforeEach, describe, expect, it, vi } from "vitest";
import { recolorStudent } from "@/lib/coloring";
import { listContactMasters, listContactOccurrences, setEventColor } from "@/lib/google";
import { getStudent } from "@/lib/students";
import { sumPaidKopecks } from "@/lib/payments";

vi.mock("@/lib/google", () => ({
  listContactMasters: vi.fn(async () => []),
  listContactOccurrences: vi.fn(async () => []),
  setEventColor: vi.fn(async () => {}),
}));
vi.mock("@/lib/students", () => ({ getStudent: vi.fn() }));
vi.mock("@/lib/payments", () => ({ sumPaidKopecks: vi.fn(async () => 0) }));

const NOW = new Date("2026-07-12T09:00:00.000Z").getTime();

const STUDENT = {
  id: "stu-1",
  contactKey: "key",
  rateKopecks: 150000, // 1500 ₽/час
};

function occ(startIso: string, hours = 1, colorId: string | null = null) {
  return { instanceId: `i-${startIso}`, start: new Date(startIso), hours, colorId };
}

// Какие цвета выставлены каким инстансам за прогон.
function applied(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [id, color] of vi.mocked(setEventColor).mock.calls) out[id] = color;
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date(NOW));
  // mockResolvedValue переживает clearAllMocks — задаём дефолты каждому тесту заново.
  vi.mocked(getStudent).mockResolvedValue(STUDENT as any);
  vi.mocked(listContactMasters).mockResolvedValue([]);
  vi.mocked(listContactOccurrences).mockResolvedValue([]);
  vi.mocked(sumPaidKopecks).mockResolvedValue(0);
});

describe("recolorStudent — балансовая покраска", () => {
  it("матрица оплачено×прошло: зелёный/красный/оранжевый/нейтральный", async () => {
    vi.mocked(sumPaidKopecks).mockResolvedValue(450000); // 3 часа по ставке
    vi.mocked(listContactOccurrences).mockResolvedValue([
      occ("2026-06-24T15:10:00.000Z"), // прошло, оплачено (самое раннее) → 10
      occ("2026-07-01T15:10:00.000Z"), // прошло, оплачено → 10
      occ("2026-07-08T15:10:00.000Z"), // прошло, оплачено → 10
      occ("2026-07-14T15:10:00.000Z"), // будущее, баланс кончился → null, но цвет уже null — не патчим
      occ("2026-07-21T15:10:00.000Z", 1, "6"), // будущее не оплачено, был оранжевый → снять в null
    ] as any);

    await recolorStudent("stu-1");

    expect(applied()).toEqual({
      "i-2026-06-24T15:10:00.000Z": "10",
      "i-2026-07-01T15:10:00.000Z": "10",
      "i-2026-07-08T15:10:00.000Z": "10",
      "i-2026-07-21T15:10:00.000Z": null,
    });
  });

  it("блок «всё-или-ничего»: не хватает на весь блок — блок не оплачен", async () => {
    vi.mocked(sumPaidKopecks).mockResolvedValue(150000); // 1 час
    vi.mocked(listContactOccurrences).mockResolvedValue([
      occ("2026-07-14T07:00:00.000Z", 2), // блок 2 часа, остатка (1) не хватает
      occ("2026-07-21T15:10:00.000Z", 1), // дальше всё неоплачено — без перескока
    ] as any);

    await recolorStudent("stu-1");

    // Будущие неоплаченные → null, а цвета и так null — ни одного вызова.
    expect(setEventColor).not.toHaveBeenCalled();
  });

  it("после первого недостатка баланс не перескакивает на меньшие блоки", async () => {
    vi.mocked(sumPaidKopecks).mockResolvedValue(150000); // 1 час
    vi.mocked(listContactOccurrences).mockResolvedValue([
      occ("2026-07-01T07:00:00.000Z", 2), // прошло, не хватает → красный
      occ("2026-07-08T15:10:00.000Z", 1), // прошло, 1 час есть, но exhausted → красный
    ] as any);

    await recolorStudent("stu-1");

    expect(applied()).toEqual({
      "i-2026-07-01T07:00:00.000Z": "11",
      "i-2026-07-08T15:10:00.000Z": "11",
    });
  });

  it("без ставки оплаченных часов нет: прошлое красное, будущее нейтральное", async () => {
    vi.mocked(getStudent).mockResolvedValue({ ...STUDENT, rateKopecks: 0 } as any);
    vi.mocked(sumPaidKopecks).mockResolvedValue(1000000);
    vi.mocked(listContactOccurrences).mockResolvedValue([
      occ("2026-07-01T15:10:00.000Z"),
      occ("2026-07-14T15:10:00.000Z"),
    ] as any);

    await recolorStudent("stu-1");

    expect(applied()).toEqual({ "i-2026-07-01T15:10:00.000Z": "11" });
  });

  it("сбрасывает цвет мастеров серий, чтобы повторы не наследовали старый", async () => {
    vi.mocked(sumPaidKopecks).mockResolvedValue(0);
    vi.mocked(listContactMasters).mockResolvedValue([
      { id: "master-1", colorId: "10" },
      { id: "master-2", colorId: null }, // нейтральный — не трогаем
    ] as any);

    await recolorStudent("stu-1");

    expect(applied()).toEqual({ "master-1": null });
  });

  it("верный цвет не перепатчивается (бережём квоту API)", async () => {
    vi.mocked(sumPaidKopecks).mockResolvedValue(150000);
    vi.mocked(listContactOccurrences).mockResolvedValue([
      occ("2026-07-01T15:10:00.000Z", 1, "10"), // уже зелёное
    ] as any);

    await recolorStudent("stu-1");

    expect(setEventColor).not.toHaveBeenCalled();
  });

  it("неизвестный ученик — тихо выходим", async () => {
    vi.mocked(getStudent).mockResolvedValue(null as any);
    await recolorStudent("нет-такого");
    expect(sumPaidKopecks).not.toHaveBeenCalled();
  });
});
