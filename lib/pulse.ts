// Вопрос «как прошло занятие?» сразу после его конца. Дёргается каждые ~15 минут
// (GitHub Actions cron → /api/cron/pulse; на бесплатном Vercel кроны только раз в день).
// Окно поиска — сутки назад: переживает простои планировщика, а дубликаты отсекает
// таблица lesson_pings. Кнопки те же, что были в утреннем дайджесте: «Прошло»
// (подтверждение/откат пропуска), «Не прошло» (серый, не тарифицируется), «📝» (заметка).
import { listDayOccurrences } from "./google";
import { MISSED_COLOR_ID, SLOT_MINUTES, SLOT_STEP_MINUTES } from "./config";
import { pingSent, recordPing } from "./pings";
import { escapeHtml, inlineKeyboard, sendOwner } from "./telegram";
import { formatMskRange } from "./slots";

// Конец блока из N часов: (N-1) полных шагов сетки + само занятие.
function blockEndMs(start: Date, hours: number): number {
  return start.getTime() + ((hours - 1) * SLOT_STEP_MINUTES + SLOT_MINUTES) * 60000;
}

export async function sendFinishedLessonPrompts(now: Date): Promise<{ sent: number }> {
  const from = new Date(now.getTime() - 24 * 3600000);
  const occ = await listDayOccurrences(from, now);
  let sent = 0;
  for (const o of occ) {
    try {
      if (blockEndMs(o.start, o.hours) > now.getTime()) continue; // ещё идёт или впереди
      if (o.colorId === MISSED_COLOR_ID) continue; // уже помечено пропуском
      if (await pingSent(o.instanceId)) continue;

      await sendOwner(
        `🏁 <b>Занятие завершилось</b>\n\n🧑‍🎓 ${escapeHtml(o.student || "?")} · ${escapeHtml(
          o.subject
        )}\n🕒 ${escapeHtml(formatMskRange(o.start.toISOString(), o.hours))}\n\nКак прошло?`,
        inlineKeyboard([
          [
            { text: "✅ Прошло", data: `ldone:${o.instanceId}` },
            { text: "❌ Не прошло", data: `lmiss:${o.instanceId}` },
            { text: "📝", data: `lrep:${o.instanceId}` },
          ],
        ])
      );
      await recordPing(o.instanceId);
      sent++;
    } catch (e) {
      console.error("pulse: occurrence failed", o.instanceId, e);
    }
  }
  return { sent };
}
