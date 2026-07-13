// Утренние задачи ежедневного крона (09:00 МСК, vercel.json → /api/cron/morning):
// 1) пробные ученики, у которых пробное прошло, — вопрос владельцу «что дальше?»;
// 2) отчёт владельцу «занятия за вчера» с кнопками «Прошло / Не прошло» (пропуск —
//    серый цвет, не тарифицируется);
// 3) напоминания ученикам с подключёнными уведомлениями «сегодня занятие в …».
import { listContactOccurrences, listDayOccurrences, type DayOccurrence } from "./google";
import { getStudent, listTrialPending, updateStudent } from "./students";
import { escapeHtml, inlineKeyboard, sendOwner, type TgButton } from "./telegram";
import { notifyStudent } from "./notify";
import { MISSED_COLOR_ID, MSK_OFFSET_MINUTES } from "./config";

// Начало суток МСК (в UTC-моменте) для дня, отстоящего на offsetDays от сегодняшнего.
export function mskDayStart(now: Date, offsetDays = 0): Date {
  const msk = new Date(now.getTime() + MSK_OFFSET_MINUTES * 60000);
  const dayUtcMs = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
  return new Date(dayUtcMs - MSK_OFFSET_MINUTES * 60000 + offsetDays * 86400000);
}

const hmMsk = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);

const dayMsk = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    day: "numeric",
    month: "long",
  }).format(d);

// Пробные ученики: пробное занятие прошло → владельцу вопрос с кнопками
// «Полноценный ученик» (mkfull:) / «Удалить» (delstu:). Одноразово (trialNotifiedAt).
export async function notifyTrialsPassed(
  now: Date
): Promise<{ checked: number; notified: number }> {
  const pending = await listTrialPending();
  let notified = 0;
  for (const s of pending) {
    try {
      // Прошедшее ПОДТВЕРЖДЁННОЕ занятие — пробное состоялось.
      const occ = await listContactOccurrences(s.contactKey);
      if (!occ.some((o) => o.start.getTime() < now.getTime())) continue;

      await sendOwner(
        `🎯 <b>Пробное занятие прошло</b>\n\n🧑‍🎓 ${escapeHtml(s.name)}\n📚 ${escapeHtml(
          s.subject
        )}${s.tg ? `\n✈️ ${escapeHtml(s.tg)}` : ""}\n\nПродолжаете заниматься?`,
        inlineKeyboard([
          [{ text: "✅ Полноценный ученик", data: `mkfull:${s.id}` }],
          [{ text: "🗑 Удалить ученика", data: `delstu:${s.id}` }],
        ])
      );
      await updateStudent(s.id, { trialNotifiedAt: new Date() });
      notified++;
    } catch (e) {
      console.error("morning/trial: student failed", s.id, e);
    }
  }
  return { checked: pending.length, notified };
}

// Отчёт «занятия за вчера»: одно сообщение владельцу, по кнопочной строке на занятие.
// «Прошло» (ldone:) — подтверждение (и откат ошибочного пропуска), «Не прошло»
// (lmiss:) — серый цвет + исключение из тарификации. Возвращает число занятий.
export async function sendYesterdayReport(now: Date): Promise<{ lessons: number }> {
  const from = mskDayStart(now, -1);
  const to = mskDayStart(now, 0);
  const occ = await listDayOccurrences(from, to);
  if (!occ.length) return { lessons: 0 }; // нет занятий — не шумим

  const lines = [`📋 <b>Занятия за вчера (${dayMsk(from)})</b>\nОтметьте, прошло ли каждое:`];
  const rows: TgButton[][] = [];
  for (const o of occ) {
    const label = `${hmMsk(o.start)} ${o.student || "?"}`;
    const missed = o.colorId === MISSED_COLOR_ID;
    lines.push(
      `• ${hmMsk(o.start)} — ${escapeHtml(o.student || "?")} · ${escapeHtml(o.subject)}${
        missed ? " · 🚫 уже отмечено пропуском" : ""
      }`
    );
    rows.push([
      { text: `✅ ${label}`, data: `ldone:${o.instanceId}` },
      { text: "❌ не прошло", data: `lmiss:${o.instanceId}` },
    ]);
  }
  await sendOwner(lines.join("\n"), inlineKeyboard(rows));
  return { lessons: occ.length };
}

// Напоминания ученикам: у кого сегодня занятие и подключены уведомления —
// «сегодня занятие в …». Возвращает число отправленных напоминаний.
export async function sendTodayReminders(now: Date): Promise<{ reminders: number }> {
  const from = mskDayStart(now, 0);
  const to = mskDayStart(now, 1);
  const occ = await listDayOccurrences(from, to);

  // Группируем по ученику: у блока/нескольких занятий в день — одно сообщение.
  const byStudent = new Map<string, DayOccurrence[]>();
  for (const o of occ) {
    if (!o.studentId) continue;
    const list = byStudent.get(o.studentId) || [];
    list.push(o);
    byStudent.set(o.studentId, list);
  }

  let reminders = 0;
  for (const [studentId, list] of byStudent) {
    try {
      const s = await getStudent(studentId);
      if (!s?.tgChatId) continue;
      const times = list.map((o) => hmMsk(o.start)).join(", ");
      await notifyStudent(
        s,
        `🔔 Напоминание: сегодня ${list.length > 1 ? "занятия" : "занятие"} в <b>${times}</b> (МСК).`
      );
      reminders++;
    } catch (e) {
      console.error("morning/reminder failed", studentId, e);
    }
  }
  return { reminders };
}
