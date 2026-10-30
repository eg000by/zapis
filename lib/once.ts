// «Отправить ровно один раз», когда пульс дёргают два планировщика сразу
// (cron-job.org и цикл в GitHub Actions) и прогоны могут прийти одновременно.
//
// Отметка «отправлено» (key) ставится ПОСЛЕ отправки, а одновременные прогоны
// разводит аренда (lock:key), которая протухает через LEASE_TTL_MS. Так:
//   • два прогона одновременно — отправит только тот, кто взял аренду;
//   • send бросил — аренду снимаем, следующий прогон попробует снова;
//   • функцию убили посреди send (таймаут, деплой) — аренда протухнет, и
//     следующий прогон отправит. Отметка «до отправки» тут потеряла бы сообщение.
// Остаётся один узкий случай: убили между send и записью отметки — тогда
// сообщение уйдёт повторно. Лишнее сообщение лучше пропавшего.
import { claimLease, pingSent, recordPing, releaseClaim } from "./pings";

// С запасом больше самого долгого прогона пульса: свежую аренду живого прогона
// перехватывать нельзя.
export const LEASE_TTL_MS = 3 * 60000;

// true — отправили в этот раз; false — уже отправлено или отправляет другой прогон.
export async function sendOnce(key: string, send: () => Promise<void>): Promise<boolean> {
  if (await pingSent(key)) return false; // дёшево: обычный случай — уже отправлено
  const lock = `lock:${key}`;
  if (!(await claimLease(lock, LEASE_TTL_MS))) return false;
  try {
    // Ещё раз уже под арендой: соседний прогон мог отправить и снять аренду между
    // первой проверкой и захватом. Отметку он пишет ДО снятия аренды — здесь её видно.
    if (await pingSent(key)) {
      await releaseClaim(lock).catch(() => {});
      return false;
    }
    await send();
  } catch (e) {
    await releaseClaim(lock).catch(() => {});
    throw e;
  }
  await recordPing(key);
  await releaseClaim(lock).catch(() => {}); // не снялась — протухнет сама
  return true;
}
