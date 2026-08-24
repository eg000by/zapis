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
import { ensureAutoInvoices } from "./autobill";
import { activeMembers } from "./groups";

// Конец блока из N часов: (N-1) полных шагов сетки + само занятие.
function blockEndMs(start: Date, hours: number): number {
  return start.getTime() + ((hours - 1) * SLOT_STEP_MINUTES + SLOT_MINUTES) * 60000;
}

export async function sendFinishedLessonPrompts(now: Date): Promise<{ sent: number; billed: number }> {
  const from = new Date(now.getTime() - 24 * 3600000);
  const occ = await listDayOccurrences(from, now);
  let sent = 0;
  let billed = 0;
  // Ученики, у которых занятие только что закончилось: счёт за долг выставляем
  // сразу, не дожидаясь, пока ученик откроет кабинет. Один ученик — один пересчёт
  // за прогон (ensureAutoInvoices идемпотентен и считает весь баланс целиком).
  const toBill = new Map<string, string>();
  for (const o of occ) {
    try {
      if (blockEndMs(o.start, o.hours) > now.getTime()) continue; // ещё идёт или впереди
      if (o.colorId === MISSED_COLOR_ID) continue; // уже помечено пропуском
      if (await pingSent(o.instanceId)) continue;

      // Групповое занятие касается всех участников: счёт после занятия должен
      // появиться у каждого, а не потеряться из-за пустого studentId. У обычного
      // занятия ученик уже известен из события — лишний запрос в БД не делаем.
      if (o.groupId) for (const m of await activeMembers(o.groupId)) toBill.set(m.id, m.name);
      else if (o.studentId) toBill.set(o.studentId, o.student || "");
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

  // Счета за проведённые занятия — сразу после занятия (best-effort: сбой БД или
  // ЮKassa не должен ронять пульс). Если баланса хватает, счёт не появится: внутри
  // тот же расчёт, что и в кабинете.
  //
  // Цвета здесь НЕ трогаем: покраска «долг» — следствие решения преподавателя, что
  // занятие состоялось («Прошло» или заметка 📝). Ничего не нажали — занятие остаётся
  // нейтральным, даже если время его уже прошло.
  for (const [studentId, name] of toBill) {
    try {
      await ensureAutoInvoices(studentId, name);
      billed++;
    } catch (e) {
      console.error("pulse: autobill failed", studentId, e);
    }
  }
  return { sent, billed };
}
