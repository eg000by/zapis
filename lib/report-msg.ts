// Сообщение «🏁 Занятие завершилось» после нажатия кнопки. Раньше оно висело как
// было — с вопросом «Как прошло?» и всеми кнопками, будто ответа не было. Теперь
// вопрос заменяется итогом («✅ Проведено» / «🚫 Не состоялось»), а кнопки —
// «📝 Заметка» и «↩️ Изменить» (вернуть вопрос, если нажал не то).
//
// Текст берём из самого сообщения (Telegram отдаёт его без разметки): шапка и
// строки «кто/когда» уже там, лишний раз ходить в календарь не нужно.
import { activeMembers } from "./groups";
import { attendanceKeyboard } from "./attendance";
import { CALENDAR_ID, calendarClient } from "./google";
import { editMessageText, escapeHtml, inlineKeyboard, type TgButton } from "./telegram";

export const REPORT_QUESTION = "Как прошло?";
export const GROUP_QUESTION = "Кто был? Нажмите на того, кого не было, — и «Готово».";

export type ReportOutcome = "done" | "missed";

export function reportKeyboard(instanceId: string): TgButton[][] {
  return [
    [
      { text: "✅ Прошло", data: `ldone:${instanceId}` },
      { text: "❌ Не прошло", data: `lmiss:${instanceId}` },
      { text: "📝", data: `lrep:${instanceId}` },
    ],
  ];
}

interface ParsedReport {
  head: string; // HTML: «🏁 <b>Занятие завершилось</b>\n\n🧑‍🎓 … \n🕒 …»
  group: boolean;
  open: boolean; // ещё висит вопрос — ответа не было
}

// Разбирает текст сообщения-отчёта. Не отчёт (экран «Занятия», что угодно ещё) — null:
// такие сообщения не трогаем.
export function parseReport(plain: string | undefined | null): ParsedReport | null {
  if (!plain) return null;
  const parts = plain.split("\n\n");
  const title = parts[0] ?? "";
  if (parts.length < 2 || !/^🏁 Занятие (группы )?завершилось$/.test(title)) return null;
  const tail = parts.slice(2).join("\n\n");
  return {
    head: `🏁 <b>${escapeHtml(title.replace(/^🏁\s*/, ""))}</b>\n\n${escapeHtml(parts[1])}`,
    group: title.includes("группы"),
    open: tail === REPORT_QUESTION || tail === GROUP_QUESTION,
  };
}

// Чистая сборка итогового экрана (для тестов).
export function resolvedReport(
  r: ParsedReport,
  instanceId: string,
  outcome: ReportOutcome
): { text: string; keyboard: TgButton[][] } {
  const status =
    outcome === "done"
      ? "✅ Проведено"
      : r.group
        ? "🚫 Занятия не было — не тарифицируется"
        : "🚫 Не состоялось — не тарифицируется";
  const change: TgButton = { text: "↩️ Изменить", data: `lchg:${instanceId}` };
  const row: TgButton[] =
    outcome === "done" ? [{ text: "📝 Заметка", data: `lrep:${instanceId}` }, change] : [change];
  return { text: `${r.head}\n\n${status}`, keyboard: [row] };
}

// Заменяет вопрос итогом. Сообщение не отчёт (кнопка нажата с другого экрана) —
// ничего не делает.
export async function resolveReport(
  chatId: number | string,
  messageId: number | null | undefined,
  plain: string | undefined,
  instanceId: string,
  outcome: ReportOutcome
): Promise<void> {
  const r = parseReport(plain);
  if (!r || !messageId) return;
  const { text, keyboard } = resolvedReport(r, instanceId, outcome);
  await editMessageText(chatId, messageId, text, inlineKeyboard(keyboard)).catch((e) =>
    console.error("report: не удалось обновить сообщение", e)
  );
}

// «↩️ Изменить»: возвращает вопрос и исходные кнопки. У группы — отметку состава
// заново (по умолчанию все были), для неё нужен текущий список участников.
export async function reopenReport(
  chatId: number | string,
  messageId: number | null | undefined,
  plain: string | undefined,
  instanceId: string
): Promise<boolean> {
  const r = parseReport(plain);
  if (!r || !messageId) return false;
  if (!r.group) {
    await editMessageText(
      chatId,
      messageId,
      `${r.head}\n\n${REPORT_QUESTION}`,
      inlineKeyboard(reportKeyboard(instanceId))
    );
    return true;
  }
  let groupId: string | undefined;
  try {
    const ev = (await calendarClient().events.get({ calendarId: CALENDAR_ID, eventId: instanceId })).data;
    groupId = ev.extendedProperties?.private?.groupId;
  } catch {
    return false;
  }
  if (!groupId) return false;
  const members = await activeMembers(groupId);
  if (!members.length) return false;
  await editMessageText(
    chatId,
    messageId,
    `${r.head}\n\n${GROUP_QUESTION}`,
    inlineKeyboard(attendanceKeyboard(members, instanceId))
  );
  return true;
}
