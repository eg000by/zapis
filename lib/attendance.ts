// Посещаемость группового занятия. Занятие одно на всех, а пришли не все — и цвет
// события про это сказать не может (он один на четверых). Поэтому пропуск здесь
// персональный: строка занятия ученика со статусом missed, которая исключает это
// занятие из ЕГО тарификации (lib/lessons.ts → lib/balance.ts).
//
// Состояние экрана живёт в самих кнопках: «✅ Егор» / «❌ Егор». Так сделано не от
// лени — в callback_data не помещаются вместе id занятия (44 символа) и id ученика
// (36) при лимите Telegram в 64 байта, а класть список в botState нельзя: там одна
// строка на чат, и два подряд закончившихся занятия затёрли бы друг друга.
import { CALENDAR_ID, calendarClient } from "./google";
import { activeMembers } from "./groups";
import { setAttendance } from "./lessons";
import { ensureAutoInvoices } from "./autobill";
import { editMessageReplyMarkup, editMessageText, escapeHtml, type TgButton } from "./telegram";
import { formatMskRange } from "./slots";

const PRESENT = "✅";
const ABSENT = "❌";

export interface KeyboardRow {
  text: string;
  callback_data?: string;
}

// Клавиатура отметки: по два ученика в ряд, затем «Готово», заметка и «занятия не было».
export function attendanceKeyboard(
  members: { name: string }[],
  instanceId: string,
  absent: Set<number> = new Set()
): TgButton[][] {
  const rows: TgButton[][] = [];
  for (let i = 0; i < members.length; i += 2) {
    rows.push(
      members.slice(i, i + 2).map((m, j) => ({
        text: `${absent.has(i + j) ? ABSENT : PRESENT} ${m.name}`,
        data: `att:${i + j}`,
      }))
    );
  }
  rows.push([
    { text: "💾 Готово", data: `attok:${instanceId}` },
    { text: "📝", data: `lrep:${instanceId}` },
  ]);
  rows.push([{ text: "🚫 Занятия не было", data: `lmiss:${instanceId}` }]);
  return rows;
}

// Разбирает состояние из клавиатуры сообщения: имена по порядку и кто отмечен
// пропустившим. Кнопки не-учеников (Готово, заметка) пропускаем по callback_data.
export function parseAttendance(markup: unknown): { names: string[]; absent: Set<number> } {
  const rows = (markup as { inline_keyboard?: KeyboardRow[][] })?.inline_keyboard || [];
  const names: string[] = [];
  const absent = new Set<number>();
  for (const row of rows) {
    for (const b of row) {
      if (!b.callback_data?.startsWith("att:")) continue;
      const idx = Number(b.callback_data.slice(4));
      if (!Number.isInteger(idx)) continue;
      names[idx] = b.text.replace(PRESENT, "").replace(ABSENT, "").trim();
      if (b.text.startsWith(ABSENT)) absent.add(idx);
    }
  }
  return { names: [...names], absent };
}

// Переключает одного ученика присутствовал/пропустил прямо в сообщении.
export async function toggleAttendance(
  chatId: number | string,
  messageId: number,
  markup: unknown,
  index: number
): Promise<string> {
  const rows = ((markup as { inline_keyboard?: KeyboardRow[][] })?.inline_keyboard || []).map(
    (row) =>
      row.map((b) => {
        if (b.callback_data !== `att:${index}`) return { text: b.text, data: b.callback_data || "" };
        const wasAbsent = b.text.startsWith(ABSENT);
        return {
          text: `${wasAbsent ? PRESENT : ABSENT} ${b.text.replace(PRESENT, "").replace(ABSENT, "").trim()}`,
          data: b.callback_data,
        };
      })
  );
  const { names, absent } = parseAttendance({
    inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))),
  });
  await editMessageReplyMarkup(chatId, messageId, {
    inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))),
  });
  const name = names[index] || "";
  return absent.has(index) ? `${name}: пропуск` : `${name}: был`;
}

// Применяет отметку: пропустившим ставит статус занятия missed, остальным — done,
// и пересчитывает счета всем участникам (у пропустившего это занятие из тарификации
// выпадает). Возвращает короткий ответ для всплывающего уведомления.
export async function applyAttendance(
  chatId: number | string,
  messageId: number,
  instanceId: string,
  markup: unknown
): Promise<string> {
  const { names, absent } = parseAttendance(markup);

  let ev;
  try {
    const res = await calendarClient().events.get({ calendarId: CALENDAR_ID, eventId: instanceId });
    ev = res.data;
  } catch {
    return "Занятие не найдено";
  }
  const priv = ev.extendedProperties?.private || {};
  const startIso = ev.start?.dateTime || ev.start?.date;
  if (!priv.groupId || !startIso) return "Это не групповое занятие";

  const members = await activeMembers(priv.groupId);
  const start = new Date(startIso);
  const hours = Number(priv.lessons) || 1;

  // Сопоставляем по имени, а не по позиции: состав мог измениться между отправкой
  // сообщения и нажатием «Готово», и тогда индекс указал бы не на того ученика.
  const missedNames: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const m = members.find((x) => x.name === names[i]);
    if (!m) continue;
    const present = !absent.has(i);
    if (!present) missedNames.push(m.name);
    try {
      await setAttendance({
        studentId: m.id,
        calendarEventId: instanceId,
        occurrenceStart: start,
        subject: priv.subject || null,
        present,
      });
    } catch (e) {
      console.error("attendance: не удалось записать", m.id, e);
    }
  }

  // Счета пересчитываем всем: у пропустившего занятие выпадает из тарификации,
  // и уже выставленный за него счёт снимается сам (расчёт идёт от баланса целиком).
  for (const m of members) {
    try {
      await ensureAutoInvoices(m.id, m.name);
    } catch (e) {
      console.error("attendance: пересчёт счетов не удался", m.id, e);
    }
  }

  const line = missedNames.length
    ? `🚫 Пропустили: ${escapeHtml(missedNames.join(", "))}`
    : "✅ Были все";
  await editMessageText(
    chatId,
    messageId,
    `🏁 <b>Занятие группы отмечено</b>\n\n` +
      `👥 ${escapeHtml(priv.student || "группа")}\n` +
      `🕒 ${escapeHtml(formatMskRange(start.toISOString(), hours))}\n\n` +
      `${line}\n\nСчета пересчитаны: пропущенное занятие не тарифицируется.`
  );
  return missedNames.length ? `Отмечено · пропусков: ${missedNames.length}` : "Отмечено · были все";
}
