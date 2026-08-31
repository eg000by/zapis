// Панель дня: ОДНО закреплённое сообщение вместо ленты уведомлений. Бот переписывает
// его по ходу дня — занятия сегодня и долги, — поэтому оно всегда актуально и не растёт.
//
// Почему закреп, а не сообщение: экраны бота уплывают вверх вместе с перепиской, а
// закреплённое видно в шапке чата всегда. Кнопка «Сегодня» показывает панель заново
// внизу (и снова закрепляет) — чтобы ответ был там, куда смотришь.
import { listDayOccurrences } from "./google";
import { listDebtors } from "./stats";
import { getSetting, setSetting } from "./settings";
import {
  deleteMessage,
  editMessageText,
  escapeHtml,
  inlineKeyboard,
  pinChatMessage,
  sendOwner,
  type TgButton,
} from "./telegram";
import { MSK_OFFSET_MINUTES } from "./config";

const PANEL_KEY = "panelMessageId";
const rub = (kopecks: number) => (kopecks / 100).toLocaleString("ru-RU");

// Границы сегодняшних суток по МСК: сервис живёт в одном поясе, и «сегодня» считается
// по нему, а не по времени сервера.
function mskDayBounds(now: Date): { from: Date; to: Date } {
  const shifted = new Date(now.getTime() + MSK_OFFSET_MINUTES * 60000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const from = new Date(Date.UTC(y, m, d) - MSK_OFFSET_MINUTES * 60000);
  return { from, to: new Date(from.getTime() + 86400000) };
}

function hm(d: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function dayTitle(d: Date): string {
  const s = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Текст и кнопки панели. Считается из тех же источников, что и остальные экраны:
// занятия — из календаря, долги — из балансового прохода.
export async function renderPanel(now = new Date()): Promise<{ text: string; keyboard: unknown }> {
  const { from, to } = mskDayBounds(now);
  const [occ, debtors] = await Promise.all([
    listDayOccurrences(from, to).catch((e) => {
      console.error("panel: occurrences failed", e);
      return [];
    }),
    listDebtors().catch((e) => {
      console.error("panel: debtors failed", e);
      return [];
    }),
  ]);

  const lines = [`📅 <b>${escapeHtml(dayTitle(now))}</b>`];
  if (!occ.length) {
    lines.push("\nЗанятий сегодня нет.");
  } else {
    const done = occ.filter((o) => o.start.getTime() <= now.getTime()).length;
    lines.push(`\n<b>Занятия</b> · ${done} из ${occ.length} позади`);
    for (const o of occ) {
      const past = o.start.getTime() <= now.getTime();
      const who = o.groupId ? `👥 ${o.student || "группа"}` : `🧑‍🎓 ${o.student || "?"}`;
      lines.push(`${past ? "✓" : "•"} ${hm(o.start)} ${escapeHtml(who)}`);
    }
  }

  // Долги — вторая половина панели: это то, ради чего в бот заходят между занятиями.
  const active = debtors.filter((d) => d.active);
  if (active.length) {
    const total = active.reduce((s, d) => s + d.debtKopecks, 0);
    lines.push(`\n<b>Долги</b> · ${rub(total)} ₽ у ${active.length}`);
    for (const d of active.slice(0, 5)) {
      lines.push(`🔴 ${escapeHtml(d.name)} — ${rub(d.debtKopecks)} ₽`);
    }
    if (active.length > 5) lines.push(`…и ещё ${active.length - 5}`);
  } else {
    lines.push("\nДолгов нет.");
  }

  const kb: TgButton[][] = [
    [
      { text: "👥 Ученики", data: "stus" },
      { text: "🧾 Долги", data: "debts" },
    ],
    [{ text: "🔄 Обновить", data: "panel" }],
  ];
  return { text: lines.join("\n"), keyboard: inlineKeyboard(kb) };
}

// Обновляет панель. bump — показать её заново внизу переписки (нажали «Сегодня»):
// прежнее сообщение удаляем, чтобы панель всегда была ровно одна.
export async function refreshPanel(opts: { bump?: boolean } = {}): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  const { text, keyboard } = await renderPanel();
  const stored = Number((await getSetting(PANEL_KEY).catch(() => "")) || 0);

  if (stored && !opts.bump) {
    if (await editMessageText(chatId, stored, text, keyboard)) return;
  }
  if (stored && opts.bump) await deleteMessage(chatId, stored);

  const sent = await sendOwner(text, keyboard);
  if (!sent?.message_id) return;
  await setSetting(PANEL_KEY, String(sent.message_id)).catch((e) =>
    console.error("panel: сохранить id не вышло", e)
  );
  // Закреп — чтобы панель была видна в шапке чата, а не только внизу.
  await pinChatMessage(chatId, sent.message_id).catch((e) =>
    console.error("panel: закрепить не вышло", e)
  );
}

// Экран «Сегодня» по кнопке меню: панель показывается заново внизу переписки.
export async function showToday(chatId: number | string, messageId: number | null): Promise<void> {
  if (messageId != null) {
    const { text, keyboard } = await renderPanel();
    if (await editMessageText(chatId, messageId, text, keyboard)) return;
  }
  await refreshPanel({ bump: true });
}
