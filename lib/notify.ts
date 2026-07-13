// Сервисные уведомления ученикам в Telegram. Бот не может написать человеку первым,
// поэтому ученик сам подключается по deep-link t.me/<бот>?start=<studentId> из кабинета —
// /start привязывает его chat_id к строке ученика (students.tg_chat_id). Все отправки
// best-effort: недоступность Telegram не должна ломать основной сценарий.
import { botUsername, sendTo } from "./telegram";
import { getStudent } from "./students";
import type { Student } from "./schema";

// Статус подключения + ссылка подключения для кабинета. link пуста, когда username
// бота неизвестен (нет токена/сети) — кнопку тогда не показываем.
export async function studentTgInfo(
  student: Pick<Student, "id" | "tgChatId"> | null
): Promise<{ connected: boolean; link: string }> {
  if (!student) return { connected: false, link: "" };
  if (student.tgChatId) return { connected: true, link: "" };
  const username = await botUsername();
  return {
    connected: false,
    link: username ? `https://t.me/${username}?start=${student.id}` : "",
  };
}

// Шлёт ученику сообщение, если он подключил уведомления. Ошибки глотаются (логируются).
export async function notifyStudent(
  student: Pick<Student, "tgChatId"> | null,
  text: string
): Promise<void> {
  if (!student?.tgChatId) return;
  try {
    await sendTo(student.tgChatId, text);
  } catch (e) {
    console.error("notifyStudent failed", e);
  }
}

// То же по id ученика (когда строки под рукой нет).
export async function notifyStudentById(studentId: string, text: string): Promise<void> {
  if (!studentId) return;
  try {
    const s = await getStudent(studentId);
    await notifyStudent(s, text);
  } catch (e) {
    console.error("notifyStudentById failed", e);
  }
}
