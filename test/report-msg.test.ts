// Сообщение «🏁 Занятие завершилось» после ответа должно меняться: вопрос уходит,
// вместо него итог и «↩️ Изменить». Раньше оно висело как было — будто не нажали.
import { describe, expect, it } from "vitest";
import {
  GROUP_QUESTION,
  REPORT_QUESTION,
  parseReport,
  reportKeyboard,
  resolvedReport,
} from "@/lib/report-msg";

// Так Telegram отдаёт текст сообщения в callback: без HTML-разметки.
const PLAIN = `🏁 Занятие завершилось\n\n🧑‍🎓 Стас <R&D> · Питон\n🕒 Вт, 14 июля, 09:00–10:00\n\n${REPORT_QUESTION}`;
const GROUP = `🏁 Занятие группы завершилось\n\n👥 ОГЭ, суббота · ОГЭ информатика\n🕒 Сб, 18 июля, 09:00–10:00\n\n${GROUP_QUESTION}`;
const ID = "abc123def456ghi789jkl012mn_20260714T060000Z";

describe("отчёт о занятии", () => {
  it("разбирает отчёт: шапка снова жирная, текст экранирован, вопрос висит", () => {
    const r = parseReport(PLAIN)!;
    expect(r.open).toBe(true);
    expect(r.group).toBe(false);
    expect(r.head).toBe(
      "🏁 <b>Занятие завершилось</b>\n\n🧑‍🎓 Стас &lt;R&amp;D&gt; · Питон\n🕒 Вт, 14 июля, 09:00–10:00"
    );
  });

  it("чужие сообщения не трогаем", () => {
    expect(parseReport("📅 Занятия Стаса\n\n…")).toBeNull();
    expect(parseReport("🏁 Занятие группы отмечено\n\n👥 …")).toBeNull();
    expect(parseReport(undefined)).toBeNull();
  });

  it("«Прошло» → «✅ Проведено» + заметка и «Изменить»", () => {
    const { text, keyboard } = resolvedReport(parseReport(PLAIN)!, ID, "done");
    expect(text).toMatch(/\n\n✅ Проведено$/);
    expect(text).not.toContain(REPORT_QUESTION);
    expect(keyboard).toEqual([
      [
        { text: "📝 Заметка", data: `lrep:${ID}` },
        { text: "↩️ Изменить", data: `lchg:${ID}` },
      ],
    ]);
    // Отвеченный отчёт больше не «открыт» — 📝 его повторно не закрывает.
    expect(parseReport(text.replace(/<\/?b>/g, ""))?.open).toBe(false);
  });

  it("«Не прошло» → «🚫 Не состоялось», только «Изменить»", () => {
    const { text, keyboard } = resolvedReport(parseReport(PLAIN)!, ID, "missed");
    expect(text).toMatch(/🚫 Не состоялось — не тарифицируется$/);
    expect(keyboard).toEqual([[{ text: "↩️ Изменить", data: `lchg:${ID}` }]]);
  });

  it("группа: «Занятия не было»", () => {
    const r = parseReport(GROUP)!;
    expect(r.group).toBe(true);
    expect(r.open).toBe(true);
    expect(resolvedReport(r, ID, "missed").text).toMatch(/🚫 Занятия не было/);
  });

  it("все кнопки в пределах 64 байт", () => {
    const rows = [...reportKeyboard(ID), ...resolvedReport(parseReport(PLAIN)!, ID, "done").keyboard];
    for (const row of rows)
      for (const b of row) expect(Buffer.byteLength(b.data!)).toBeLessThanOrEqual(64);
  });
});
