// Отправка уведомлений и обработка ответов Telegram-бота.

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  return t;
}

async function api(method: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram API error", method, data);
  }
  return data;
}

// Уведомление о новой заявке с кнопками Подтвердить/Отклонить.
// callback_data ограничена 64 байтами — id создаваемых нами событий укладывается.
export async function notifyRequest(params: {
  eventId: string;
  name: string;
  tg: string;
  subject: string;
  when: string;
  header?: string;
  // Ревизия переноса: если задана, кнопки несут её (cr:/dr:), чтобы подтверждение
  // устаревшего уведомления о переносе распознавалось и не применяло чужой слот.
  rev?: number;
}): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID не задан");

  const tgLine = params.tg ? `\n✈️ ${params.tg}` : "";
  const text =
    `${params.header || "🆕 <b>Новая заявка на запись</b>"}\n\n` +
    `🧑‍🎓 Ученик: <b>${escapeHtml(params.name)}</b>\n` +
    `📚 Предмет: ${escapeHtml(params.subject)}\n` +
    `🕒 Время: <b>${escapeHtml(params.when)}</b>${escapeHtml(tgLine)}`;

  const confirmData =
    params.rev != null ? `cr:${params.rev}:${params.eventId}` : `c:${params.eventId}`;
  const declineData =
    params.rev != null ? `dr:${params.rev}:${params.eventId}` : `d:${params.eventId}`;

  await api("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Подтвердить", callback_data: confirmData },
          { text: "❌ Отклонить", callback_data: declineData },
        ],
      ],
    },
  });
}

export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await api("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

// Возвращает false, если править было нечего (сообщение удалено, слишком старое) —
// вызывающий тогда шлёт новое, а не молчит.
export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: unknown
): Promise<boolean> {
  const data = await api("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: clampMessage(text),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return !!data?.ok;
}

// Удаление сообщения. В личном чате бот может удалять и свои, и присланные ему —
// этим подчищается служебная переписка (приглашение к вводу, сам ввод, «сохранено»).
// Best-effort: сообщение старше 48 часов или уже удалённое — не повод падать.
export async function deleteMessage(
  chatId: number | string,
  messageId: number | null | undefined
): Promise<void> {
  if (!messageId) return;
  await api("deleteMessage", { chat_id: chatId, message_id: messageId });
}

// Меняет только клавиатуру сообщения. Нужна там, где состояние живёт в самих
// кнопках (отметка посещаемости группы): переписывать текст ради галочки нельзя —
// он собран с HTML-разметкой, и в callback его исходник уже не восстановить.
export async function editMessageReplyMarkup(
  chatId: number | string,
  messageId: number,
  replyMarkup: unknown
): Promise<void> {
  await api("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

// Telegram не обрезает длинные сообщения, а отвечает ошибкой — экран просто не
// открывается, и кнопка выглядит сломанной (api() ошибку только логирует). Режем
// сами, по границе строк: строка целиком либо не входит вовсе, поэтому HTML-теги
// (<b>…</b> живут внутри одной строки) не разрываются посередине.
const TG_TEXT_LIMIT = 4096;

function linesWord(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return "строка";
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return "строки";
  return "строк";
}

export function clampMessage(text: string, limit = TG_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  const RESERVE = 40; // место под хвост «… ещё N строк»
  for (const line of lines) {
    if (used + line.length + 1 > limit - RESERVE) break;
    kept.push(line);
    used += line.length + 1;
  }
  const hidden = lines.length - kept.length;
  return `${kept.join("\n")}\n… ещё ${hidden} ${linesWord(hidden)}`;
}

// Отправка сообщения в произвольный чат (владельцу или ученику). Превью ссылок
// выключено: карточки со ссылками (Телемост, оплата, кабинет) не разрастаются.
// Возвращает отправленное сообщение (message_id нужен для закрепа).
export async function sendTo(
  chatId: number | string,
  text: string,
  replyMarkup?: unknown
): Promise<{ message_id?: number } | null> {
  const data = await api("sendMessage", {
    chat_id: chatId,
    text: clampMessage(text),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return data?.result ?? null;
}

// Закрепляет сообщение в чате (в личном чате с ботом права не нужны).
export async function pinChatMessage(
  chatId: number | string,
  messageId: number
): Promise<void> {
  await api("pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

// Отправка сообщения владельцу (TELEGRAM_CHAT_ID) — для команд CRM.
// Возвращает отправленное сообщение: его message_id нужен, чтобы потом переписать
// это же сообщение вместо отправки нового.
export async function sendOwner(
  text: string,
  replyMarkup?: unknown
): Promise<{ message_id?: number } | null> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID не задан");
  return sendTo(chatId, text, replyMarkup);
}

// Username бота — для deep-link t.me/<бот>?start=…. Явный TELEGRAM_BOT_USERNAME из env
// либо getMe (кэшируется на жизнь лямбды). Пустая строка — узнать не удалось.
let cachedUsername: string | null = null;
export async function botUsername(): Promise<string> {
  const explicit = (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
  if (explicit) return explicit;
  if (cachedUsername != null) return cachedUsername;
  try {
    const data = await api("getMe", {});
    cachedUsername = String(data?.result?.username || "");
  } catch {
    cachedUsername = "";
  }
  return cachedUsername ?? "";
}

// ── Постоянное меню ─────────────────────────────────────────────────────────
// Reply-клавиатура живёт у поля ввода, а не внутри сообщения: она всегда на виду,
// не уплывает вверх вместе с перепиской и сама сообщений не создаёт. Inline-кнопки
// остаются для действий внутри экранов, где важен контекст конкретной карточки.
export const MENU_STUDENTS = "Ученики";
export const MENU_GROUPS = "Группы";

export function menuKeyboard(): unknown {
  return {
    keyboard: [[{ text: MENU_STUDENTS }, { text: MENU_GROUPS }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export interface TgButton {
  text: string;
  data: string;
}

// Telegram ограничивает callback_data 64 БАЙТАМИ, и на превышение отвечает
// BUTTON_DATA_INVALID — не отправляя сообщение целиком. Экран при этом просто не
// открывается, а кнопка выглядит сломанной: ошибка видна только в логах. Поэтому
// проверяем на месте, где данные собираются, и называем виноватую кнопку.
export const CALLBACK_DATA_LIMIT = 64;

// Собирает inline-клавиатуру из строк кнопок.
export function inlineKeyboard(rows: TgButton[][]): unknown {
  for (const row of rows) {
    for (const b of row) {
      const bytes = Buffer.byteLength(b.data, "utf8");
      if (bytes > CALLBACK_DATA_LIMIT) {
        console.error(
          `callback_data ${bytes} байт (> ${CALLBACK_DATA_LIMIT}) у кнопки «${b.text}»: ${b.data}`
        );
      }
    }
  }
  return {
    inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
  };
}

// ── uuid в callback_data ─────────────────────────────────────────────────────
// Один uuid текстом — 36 байт из 64, поэтому кнопка с ДВУМЯ id (кого и куда) в
// лимит не влезает. Те же 16 байт в base64url — 22 символа, и пара помещается.
export function packUuid(id: string): string {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return id; // не uuid — оставляем как есть
  return Buffer.from(hex, "hex").toString("base64url");
}

// Обратное преобразование. Строку, которая не является упакованным uuid (короткий
// id из тестов, старая кнопка), возвращаем без изменений.
export function unpackUuid(s: string): string {
  if (!/^[A-Za-z0-9_-]{22}$/.test(s)) return s;
  const buf = Buffer.from(s, "base64url");
  if (buf.length !== 16 || buf.toString("base64url") !== s) return s;
  const h = buf.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Запрос ответа: следующий текст владельца прилетит как reply (для ввода заметок).
export function forceReply(): unknown {
  return { force_reply: true, selective: true };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Область видимости меню команд. Telegram выбирает список по приоритету:
// конкретный чат → все личные чаты → по умолчанию. Без scope список уходит в
// «по умолчанию» и виден ВСЕМ пользователям бота — включая учеников.
export type CommandScope =
  | { type: "default" }
  | { type: "all_private_chats" }
  | { type: "chat"; chat_id: string | number };

// Регистрирует меню команд бота (список по кнопке «/» в клиенте Telegram).
export async function setMyCommands(
  commands: { command: string; description: string }[],
  scope?: CommandScope
): Promise<void> {
  await api("setMyCommands", { commands, ...(scope ? { scope } : {}) });
}

// Убирает меню команд в указанной области (пустой список = кнопки «/» нет).
export async function deleteMyCommands(scope?: CommandScope): Promise<void> {
  await api("deleteMyCommands", { ...(scope ? { scope } : {}) });
}
