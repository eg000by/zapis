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

export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: unknown
): Promise<void> {
  await api("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
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
    text,
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
export async function sendOwner(text: string, replyMarkup?: unknown): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID не задан");
  await sendTo(chatId, text, replyMarkup);
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

export interface TgButton {
  text: string;
  data: string;
}

// Собирает inline-клавиатуру из строк кнопок.
export function inlineKeyboard(rows: TgButton[][]): unknown {
  return {
    inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
  };
}

// Запрос ответа: следующий текст владельца прилетит как reply (для ввода заметок).
export function forceReply(): unknown {
  return { force_reply: true, selective: true };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Регистрирует меню команд бота (список по кнопке «/» в клиенте Telegram).
export async function setMyCommands(
  commands: { command: string; description: string }[]
): Promise<void> {
  await api("setMyCommands", { commands });
}
