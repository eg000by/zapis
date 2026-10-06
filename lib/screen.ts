// Экран бота: правим уже отправленное сообщение, а не шлём новое — переписка не
// растёт. Если править нечего (сообщение удалено, слишком старое), шлём новое.
// Возвращает id сообщения, на котором экран оказался, — следующий шаг диалога
// рисуется поверх него.
//
// Отдельный модуль, а не lib/telegram.ts: тесты подменяют функции telegram.ts, а
// вызов изнутри того же модуля подмену бы обходил.
import { editMessageText, escapeHtml, sendOwner } from "./telegram";

// Ссылка на кабинет ученика в тексте бота: по тапу открывает сайт (в <code> она бы
// копировалась), скопировать — долгим нажатием. Без «https://» — короче.
export function cabinetLink(url: string): string {
  return `<a href="${escapeHtml(url).replace(/"/g, "&quot;")}">${escapeHtml(url.replace(/^https?:\/\//, ""))}</a>`;
}

export async function emit(
  chatId: number | string,
  messageId: number | null,
  text: string,
  keyboard?: unknown
): Promise<number | null> {
  if (messageId != null && (await editMessageText(chatId, messageId, text, keyboard))) return messageId;
  return (await sendOwner(text, keyboard))?.message_id ?? null;
}
