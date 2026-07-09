// CRM-управление из Telegram (Фаза 4). Тонкая обёртка над тем же сервисным слоем
// lib/*, что и сайт /admin (паритет): список учеников, карточка, оплаты (отметка
// оплаты + перекраска), занятия, заметки через forced reply. Всё — под владельцем.
import {
  editMessageText,
  forceReply,
  inlineKeyboard,
  sendOwner,
  escapeHtml,
  type TgButton,
} from "./telegram";
import { getStudent, listStudents, updateStudent } from "./students";
import { getLesson, listStudentLessons, setLessonNote } from "./lessons";
import {
  getPayment,
  listStudentPayments,
  outstandingPayments,
  setPaymentStatus,
} from "./payments";
import { recolorPaymentLessons } from "./coloring";
import { clearState, getState, setState } from "./botstate";
import { formatMskRange } from "./slots";
import type { Lesson } from "./schema";

const rub = (kopecks: number) => (kopecks / 100).toLocaleString("ru-RU");

const LES_STATUS: Record<string, string> = {
  pending: "⏳",
  confirmed: "✅",
  done: "✔️",
  cancelled: "🚫",
};
const PAY_STATUS: Record<string, string> = {
  unpaid: "🔴",
  paid: "🟢",
  canceled: "⚪",
};

function lessonWhen(l: Lesson): string {
  if (!l.occurrenceStart) return "—";
  const iso =
    l.occurrenceStart instanceof Date ? l.occurrenceStart.toISOString() : String(l.occurrenceStart);
  return formatMskRange(iso, 1);
}

// Отправляет новое сообщение (messageId=null) либо редактирует существующее.
async function emit(
  chatId: number | string,
  messageId: number | null,
  text: string,
  keyboard?: unknown
): Promise<void> {
  if (messageId != null) await editMessageText(chatId, messageId, text, keyboard);
  else await sendOwner(text, keyboard);
}

export async function showStudentsList(
  chatId: number | string,
  messageId: number | null
): Promise<void> {
  const all = await listStudents();
  const active = all.filter((s) => s.active);
  const rows: TgButton[][] = active.map((s) => [
    { text: `${s.name} · ${s.subject}`, data: `stu:${s.id}` },
  ]);
  const text = active.length
    ? "<b>👥 Ученики</b>\nВыберите ученика:"
    : "<b>👥 Ученики</b>\n\nПока пусто. Создайте ученика на сайте /admin.";
  await emit(chatId, messageId, text, rows.length ? inlineKeyboard(rows) : undefined);
}

export async function showStudentCard(
  chatId: number | string,
  messageId: number | null,
  studentId: string
): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) {
    await emit(chatId, messageId, "Ученик не найден.");
    return;
  }
  const outstanding = await outstandingPayments(s.id);
  const debt = outstanding.reduce((sum, p) => sum + p.amountKopecks, 0);

  const lines = [
    `🧑‍🎓 <b>${escapeHtml(s.name)}</b>${s.active ? "" : " · 🚫 архив"}`,
    `📚 ${escapeHtml(s.subject)}${s.tg ? ` · ${escapeHtml(s.tg)}` : ""}`,
    `💰 ${s.rateKopecks > 0 ? `${rub(s.rateKopecks)} ₽/час` : "ставка не задана"} · долг: <b>${rub(debt)} ₽</b>`,
  ];
  if (s.note) lines.push(`📝 ${escapeHtml(s.note)}`);

  const keyboard = inlineKeyboard([
    [{ text: "💳 Оплаты", data: `pays:${s.id}` }, { text: "📅 Занятия", data: `les:${s.id}` }],
    [{ text: "📝 Заметка об ученике", data: `snote:${s.id}` }],
    [{ text: "⬅️ Все ученики", data: "stus" }],
  ]);
  await emit(chatId, messageId, lines.join("\n"), keyboard);
}

export async function showPayments(
  chatId: number | string,
  messageId: number | null,
  studentId: string
): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) {
    await emit(chatId, messageId, "Ученик не найден.");
    return;
  }
  const pays = await listStudentPayments(s.id);
  const lines = [`💳 <b>Оплаты — ${escapeHtml(s.name)}</b>`];
  if (!pays.length) {
    lines.push("\nСчетов нет. Создать счёт можно на сайте /admin.");
  } else {
    for (const p of pays) {
      lines.push(
        `${PAY_STATUS[p.status] || ""} ${rub(p.amountKopecks)} ₽${p.note ? ` · ${escapeHtml(p.note)}` : ""}`
      );
    }
  }
  const rows: TgButton[][] = pays
    .filter((p) => p.status !== "paid")
    .map((p) => [{ text: `✅ Оплачено ${rub(p.amountKopecks)} ₽`, data: `payp:${p.id}` }]);
  rows.push([{ text: "⬅️ Назад", data: `stu:${s.id}` }]);
  await emit(chatId, messageId, lines.join("\n"), inlineKeyboard(rows));
}

export async function showLessons(
  chatId: number | string,
  messageId: number | null,
  studentId: string
): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) {
    await emit(chatId, messageId, "Ученик не найден.");
    return;
  }
  const all = await listStudentLessons(s.id, 8);
  const les = all.filter((l) => l.status !== "cancelled");
  const lines = [`📅 <b>Занятия — ${escapeHtml(s.name)}</b>`];
  if (!les.length) lines.push("\nПока нет занятий.");
  else
    for (const l of les) {
      lines.push(
        `${LES_STATUS[l.status] || ""} ${lessonWhen(l)}${l.note ? `\n   📝 ${escapeHtml(l.note)}` : ""}`
      );
    }
  const rows: TgButton[][] = les.map((l) => [
    { text: `📝 ${lessonWhen(l)}`, data: `lnote:${l.id}` },
  ]);
  rows.push([{ text: "⬅️ Назад", data: `stu:${s.id}` }]);
  await emit(chatId, messageId, lines.join("\n"), inlineKeyboard(rows));
}

// Отмечает счёт оплаченным + перекрашивает занятия. Возвращает studentId для навигации.
export async function markPaymentPaid(paymentId: string): Promise<string | null> {
  const p = await getPayment(paymentId);
  if (!p) return null;
  await setPaymentStatus(paymentId, "paid");
  try {
    await recolorPaymentLessons(paymentId);
  } catch (e) {
    console.error("bot markPaid recolor failed", e);
  }
  return p.studentId;
}

export async function promptStudentNote(chatId: number | string, studentId: string): Promise<void> {
  await setState(String(chatId), "student.note", studentId);
  await sendOwner("✍️ Пришлите текст заметки об ученике одним сообщением:", forceReply());
}

export async function promptLessonNote(chatId: number | string, lessonId: string): Promise<void> {
  await setState(String(chatId), "lesson.note", lessonId);
  await sendOwner("✍️ Пришлите текст заметки по занятию одним сообщением:", forceReply());
}

// Если бот ждёт ввод (заметку) — сохраняет и подтверждает. Возвращает true, если обработал.
export async function applyPendingInput(chatId: number | string, text: string): Promise<boolean> {
  const st = await getState(String(chatId));
  if (!st) return false;
  const value = text.trim();
  if (st.action === "student.note") {
    await updateStudent(st.targetId, { note: value });
    await clearState(String(chatId));
    await sendOwner("✅ Заметка об ученике сохранена.");
    await showStudentCard(chatId, null, st.targetId);
    return true;
  }
  if (st.action === "lesson.note") {
    await setLessonNote(st.targetId, value);
    await clearState(String(chatId));
    const lesson = await getLesson(st.targetId);
    await sendOwner("✅ Заметка по занятию сохранена.");
    if (lesson) await showLessons(chatId, null, lesson.studentId);
    return true;
  }
  await clearState(String(chatId));
  return false;
}
