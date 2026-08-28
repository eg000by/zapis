// Сервисные уведомления ученикам в Telegram. Бот не может написать человеку первым,
// поэтому ученик сам подключается по deep-link t.me/<бот>?start=<studentId> из кабинета —
// /start привязывает его chat_id к строке ученика (students.tg_chat_id). Все отправки
// best-effort: недоступность Telegram не должна ломать основной сценарий.
import { pinChatMessage, sendTo } from "./telegram";
import { getStudent } from "./students";
import { getOrCreateStudentLinkCode } from "./shortlink";
import { siteBaseUrl, teacherTgUrl } from "./config";
import type { Student } from "./schema";

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

// Отправляет ученику сообщение с его постоянными ссылками (кабинет, звонок, доска)
// и закрепляет его в чате — вызывается при подключении уведомлений (/start).
// Best-effort: без адреса сайта/ссылок просто молчим, сбой закрепа не ломает привязку.
export async function pinStudentLinks(
  student: Pick<Student, "id" | "trial" | "meetLink" | "boardLink">,
  chatId: number | string
): Promise<void> {
  try {
    const lines = ["📌 <b>Полезные ссылки</b>"];
    const base = siteBaseUrl();
    if (base) {
      const code = await getOrCreateStudentLinkCode(student.id, student.trial);
      lines.push(`🗓 Личный кабинет (записи и оплата): ${base}/z/${code}`);
    }
    if (student.meetLink) lines.push(`🎥 Подключиться к занятию: ${student.meetLink}`);
    if (student.boardLink) lines.push(`🧩 Доска для работы: ${student.boardLink}`);
    // Контакт преподавателя — в том же закрепе: чтобы «а как с вами связаться»
    // не искалось по переписке.
    const contact = teacherTgUrl();
    if (contact) lines.push(`✉️ Вопрос преподавателю: ${contact}`);
    if (lines.length === 1) return; // закреплять нечего
    const msg = await sendTo(chatId, lines.join("\n"));
    if (msg?.message_id) await pinChatMessage(chatId, msg.message_id);
  } catch (e) {
    console.error("pinStudentLinks failed", e);
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
