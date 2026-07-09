// Состояние диалога Telegram-бота: что бот ждёт следующим сообщением владельца
// (напр. текст заметки для ученика/занятия). Одна строка на чат.
import { eq } from "drizzle-orm";
import { db } from "./db";
import { botState, type BotState } from "./schema";

export async function setState(chatId: string, action: string, targetId: string): Promise<void> {
  await db()
    .insert(botState)
    .values({ chatId, action, targetId })
    .onConflictDoUpdate({
      target: botState.chatId,
      set: { action, targetId, updatedAt: new Date() },
    });
}

export async function getState(chatId: string): Promise<BotState | null> {
  const [row] = await db().select().from(botState).where(eq(botState.chatId, chatId)).limit(1);
  return row ?? null;
}

export async function clearState(chatId: string): Promise<void> {
  await db().delete(botState).where(eq(botState.chatId, chatId));
}
