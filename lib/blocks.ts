// Группировка подряд идущих часовых слотов в единые блоки.
// Используется и на сервере (одно событие в календаре на весь блок),
// и на клиенте (показать блок «14:00–17:00», а не три отдельных часа).
import { SLOT_MINUTES } from "./config";

export interface Block {
  start: string; // ISO-начало блока (первый час)
  end: string; // ISO-конец блока (последний час + SLOT_MINUTES)
  slots: string[]; // ISO-начала всех часов блока, по порядку
}

// Группирует набор часовых слотов (ISO-начала) в блоки подряд идущих часов.
// Слоты сортируются; соседними считаются те, где начало следующего = конец предыдущего.
export function groupConsecutive(starts: string[]): Block[] {
  const sorted = Array.from(new Set(starts)).sort();
  const blocks: Block[] = [];
  for (const s of sorted) {
    const startMs = new Date(s).getTime();
    if (isNaN(startMs)) continue;
    const last = blocks[blocks.length - 1];
    if (last) {
      const prevMs = new Date(last.slots[last.slots.length - 1]).getTime();
      if (startMs === prevMs + SLOT_MINUTES * 60000) {
        last.slots.push(s);
        last.end = new Date(startMs + SLOT_MINUTES * 60000).toISOString();
        continue;
      }
    }
    blocks.push({
      start: s,
      end: new Date(startMs + SLOT_MINUTES * 60000).toISOString(),
      slots: [s],
    });
  }
  return blocks;
}
