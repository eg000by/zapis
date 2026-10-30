// Сервисные уведомления ученикам в Telegram. Бот не может написать человеку первым,
// поэтому ученик сам подключается по deep-link t.me/<бот>?start=<studentId> из кабинета —
// /start привязывает его chat_id к строке ученика (students.tg_chat_id). Все отправки
// best-effort: недоступность Telegram не должна ломать основной сценарий.
import { isChatGone, pinChatMessage, sendMessageRaw, sendTo } from "./telegram";
import { clearTgChat, getStudent } from "./students";
import { getGroup } from "./groups";
import { listContactEvents } from "./google";
import { getOrCreateStudentLinkCode } from "./shortlink";
import { siteBaseUrl, teacherTgUrl } from "./config";
import type { Student } from "./schema";

// Шлёт ученику сообщение, если он подключил уведомления. Ошибки глотаются (логируются);
// результат — дошло ли сообщение (тем, кому важен повтор при сбое).
//
// Заблокировал бота — отвязываем чат. Иначе кабинет вечно показывал бы «уведомления
// подключены», а кнопка переподключения так и не появилась бы: Telegram отказывает
// молча, ученик об этом не узнает.
export async function notifyStudent(
  student: Pick<Student, "tgChatId"> | null,
  text: string
): Promise<boolean> {
  if (!student?.tgChatId) return false;
  try {
    const data = await sendMessageRaw(student.tgChatId, text);
    if (isChatGone(data)) await clearTgChat(student.tgChatId);
    return !!data?.ok;
  } catch (e) {
    console.error("notifyStudent failed", e);
    return false;
  }
}

// Есть ли у ученика подтверждённое занятие — тот же гейт, что в /api/my: до него
// постоянные ссылки занятия (звонок, доска) никуда не отдаются. Не узнали — считаем,
// что нет: лишний раз промолчать безопаснее, чем раздать ссылку.
async function hasConfirmedLessons(
  student: Pick<Student, "contactKey" | "groupId">
): Promise<boolean> {
  try {
    const group = student.groupId ? await getGroup(student.groupId) : null;
    const key = group ? group.contactKey : student.contactKey;
    if (!key) return false;
    const events = await listContactEvents(key, new Date().toISOString());
    return events.some((e) => e.status === "confirmed");
  } catch (e) {
    console.error("hasConfirmedLessons failed", e);
    return false;
  }
}

// Отправляет ученику сообщение с его постоянными ссылками (кабинет, звонок, доска)
// и закрепляет его в чате — вызывается при подключении уведомлений (/start).
// Best-effort: без адреса сайта/ссылок просто молчим, сбой закрепа не ломает привязку.
//
// Кнопка подключения видна уже с первой заявкой, поэтому звонок и доску кладём в
// закреп, только если занятие подтверждено. Иначе /start обходил бы гейт кабинета.
// До подтверждения ссылка на звонок всё равно придёт: она есть в «Скоро занятие».
export async function pinStudentLinks(
  student: Pick<Student, "id" | "trial" | "meetLink" | "boardLink" | "contactKey" | "groupId">,
  chatId: number | string
): Promise<void> {
  try {
    const lines = ["📌 <b>Полезные ссылки</b>"];
    const base = siteBaseUrl();
    if (base) {
      const code = await getOrCreateStudentLinkCode(student.id, student.trial);
      lines.push(`🗓 Личный кабинет (записи и оплата): ${base}/z/${code}`);
    }
    if ((student.meetLink || student.boardLink) && (await hasConfirmedLessons(student))) {
      if (student.meetLink) lines.push(`🎥 Подключиться к занятию: ${student.meetLink}`);
      if (student.boardLink) lines.push(`🧩 Доска для работы: ${student.boardLink}`);
    }
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
