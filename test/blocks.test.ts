import { describe, expect, it } from "vitest";
import { groupConsecutive } from "@/lib/blocks";

// Сетка: старты через 70 минут (60 занятие + 10 перерыв).
const T10 = "2026-07-14T07:00:00.000Z"; // 10:00 МСК
const T1110 = "2026-07-14T08:10:00.000Z"; // 11:10 МСК
const T1220 = "2026-07-14T09:20:00.000Z"; // 12:20 МСК
const T1810 = "2026-07-14T15:10:00.000Z"; // 18:10 МСК

describe("groupConsecutive", () => {
  it("подряд идущие часы склеиваются в один блок", () => {
    const blocks = groupConsecutive([T10, T1110, T1220]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].slots).toEqual([T10, T1110, T1220]);
    // Конец = старт последнего занятия + 60 минут.
    expect(blocks[0].end).toBe("2026-07-14T10:20:00.000Z");
  });

  it("разрыв в сетке разбивает на отдельные блоки", () => {
    const blocks = groupConsecutive([T10, T1810]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.slots.length)).toEqual([1, 1]);
  });

  it("сортирует и убирает дубли", () => {
    const blocks = groupConsecutive([T1110, T10, T1110]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].slots).toEqual([T10, T1110]);
  });

  it("некорректные даты пропускаются", () => {
    const blocks = groupConsecutive(["мусор", T10]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start).toBe(T10);
  });

  it("пустой вход — пустой список", () => {
    expect(groupConsecutive([])).toEqual([]);
  });
});
