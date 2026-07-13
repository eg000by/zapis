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
