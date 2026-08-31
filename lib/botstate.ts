// Состояние диалога Telegram-бота: что бот ждёт следующим сообщением владельца
// (напр. текст заметки для ученика/занятия). Одна строка на чат.
import { eq } from "drizzle-orm";
import { db } from "./db";
import { botState, type BotState } from "./schema";

// promptMessageId — сообщение, которым бот попросил ввод. Ответ ученика... то есть
// владельца рисуется ПОВЕРХ него: приглашение превращается в готовый экран.
export async function setState(
  chatId: string,
  action: string,
  targetId: string,
  promptMessageId?: number | null
): Promise<void> {
  const prompt = promptMessageId ? String(promptMessageId) : "";
  await db()
    .insert(botState)
    .values({ chatId, action, targetId, promptMessageId: prompt })
    .onConflictDoUpdate({
      target: botState.chatId,
      set: { action, targetId, promptMessageId: prompt, updatedAt: new Date() },
    });
}

// Сообщение-приглашение из состояния (число или null, если его не запомнили).
export function promptIdOf(st: { promptMessageId?: string } | null): number | null {
  const n = Number(st?.promptMessageId || 0);
  return n > 0 ? n : null;
}

export async function getState(chatId: string): Promise<BotState | null> {
  const [row] = await db().select().from(botState).where(eq(botState.chatId, chatId)).limit(1);
  return row ?? null;
}

export async function clearState(chatId: string): Promise<void> {
  await db().delete(botState).where(eq(botState.chatId, chatId));
}
