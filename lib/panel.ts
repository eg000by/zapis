// Панель дня: ОДНО закреплённое сообщение вместо ленты уведомлений. Бот переписывает
// его по ходу дня — занятия сегодня и долги, — поэтому оно всегда актуально и не растёт.
//
// Почему закреп, а не сообщение: экраны бота уплывают вверх вместе с перепиской, а
// закреплённое видно в шапке чата всегда. Кнопка «Сегодня» показывает панель заново
// внизу (и снова закрепляет) — чтобы ответ был там, куда смотришь.
import { listDayOccurrences, type DayOccurrence } from "./google";
import { recentLessonNotes } from "./lessons";
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

// Длина превью заметки: обычная, укороченная для загруженного дня и 0 — без заметок.
// Панель обязана влезть в одно сообщение Telegram (4096): не влезет — правка и
// отправка упадут, и в закрепе останется вчерашнее расписание.
const NOTE_PREVIEWS = [160, 60, 0];
const PANEL_LIMIT = 4000; // с запасом до 4096

// Обрезка по символам, а не по UTF-16: эмодзи на границе не разрезается пополам.
function notePreview(n: string, max: number): string {
  const chars = Array.from(n.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

// Последняя заметка ученика ДО каждого сегодняшнего занятия (instanceId → текст):
// открыл панель утром — и видно, на чём остановились и что делать сегодня. У групп
// заметок нет (их пишут ученикам), поэтому только индивидуальные занятия. Сбой БД
// панель не роняет — просто без заметок.
async function lastNotes(occ: DayOccurrence[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const solo = occ.filter((o) => o.studentId && !o.groupId);
  if (!solo.length) return out;
  try {
    const latest = solo.reduce((t, o) => Math.max(t, o.start.getTime()), 0);
    const notes = await recentLessonNotes([...new Set(solo.map((o) => o.studentId))], new Date(latest));
    for (const o of solo) {
      const hit = notes.find((n) => n.studentId === o.studentId && n.start.getTime() < o.start.getTime());
      if (hit) out.set(o.instanceId, hit.note);
    }
  } catch (e) {
    console.error("panel: notes failed", e);
  }
  return out;
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

  const notes = occ.length ? await lastNotes(occ) : new Map<string, string>();
  const build = (preview: number): string => {
    const lines = [`📅 <b>${escapeHtml(dayTitle(now))}</b>`];
    if (!occ.length) {
      lines.push("\nЗанятий сегодня нет.");
      return lines.join("\n");
    }
    const done = occ.filter((o) => o.start.getTime() <= now.getTime()).length;
    lines.push(`\n<b>Занятия</b> · ${done} из ${occ.length} позади`);
    for (const o of occ) {
      const past = o.start.getTime() <= now.getTime();
      const who = o.groupId ? `👥 ${o.student || "группа"}` : `🧑‍🎓 ${o.student || "?"}`;
      lines.push(`${past ? "✓" : "•"} ${hm(o.start)} ${escapeHtml(who)}`);
      const note = preview > 0 ? notes.get(o.instanceId) : undefined;
      if (note) lines.push(`    📝 <i>${escapeHtml(notePreview(note, preview))}</i>`);
    }
    return lines.join("\n");
  };
  let text = "";
  for (const preview of NOTE_PREVIEWS) {
    text = build(preview);
    if (text.length <= PANEL_LIMIT) break;
  }

  // Кнопок у панели нет намеренно: любой экран, открытый из неё, переписывал бы
  // само закреплённое сообщение — и в шапке чата вместо расписания оказывался
  // список учеников. Панель только показывает день; действия — из меню снизу.
  return { text, keyboard: undefined };
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
