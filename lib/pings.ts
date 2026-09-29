// Дедупликация вопросов «как прошло занятие?»: по инстансу календаря пишем отметку,
// что сообщение уже отправлено, — pulse-крон опрашивает окно в сутки и без этого
// спрашивал бы об одном занятии при каждом запуске.
import { eq } from "drizzle-orm";
import { db } from "./db";
import { lessonPings } from "./schema";

export async function pingSent(instanceId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: lessonPings.instanceId })
    .from(lessonPings)
    .where(eq(lessonPings.instanceId, instanceId))
    .limit(1);
  return !!row;
}

export async function recordPing(instanceId: string): Promise<void> {
  await db().insert(lessonPings).values({ instanceId }).onConflictDoNothing();
}

// Дедупликация апдейтов Telegram. Не дождавшись ответа webhook, Telegram присылает
// то же нажатие ещё раз — и оно выполнялось бы повторно: вторая перекраска поверх
// идущей первой, лишние карточки в чате. update_id уникален, повтор несёт тот же.
// Отметки живут в той же таблице, что и «вопрос уже задан» (ключи не пересекаются:
// у занятий id календаря, у апдейтов — префикс tg:). Возвращает true, если апдейт
// новый и его надо обработать.
export async function claimTelegramUpdate(updateId: number): Promise<boolean> {
  const rows = await db()
    .insert(lessonPings)
    .values({ instanceId: `tg:${updateId}` })
    .onConflictDoNothing()
    .returning({ id: lessonPings.instanceId });
  return rows.length > 0;
}
