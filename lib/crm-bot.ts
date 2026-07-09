// CRM-управление из Telegram (Фаза 4). Тонкая обёртка над тем же сервисным слоем
// lib/*, что и сайт /admin (паритет): список учеников, карточка, оплаты (отметка
// оплаты + перекраска), занятия, заметки через forced reply. Всё — под владельцем.
import {
  editMessageText,
  inlineKeyboard,
  sendOwner,
  escapeHtml,
  type TgButton,
} from "./telegram";
import { getStudent, listStudents, updateStudent, upsertStudent } from "./students";
import { getLesson, listStudentLessons, setLessonNote } from "./lessons";
import {
  createPayment,
  deletePayment,
  getPayment,
  lessonIdsForPayment,
  listStudentPayments,
  outstandingPayments,
  setPayLink,
  setPaymentStatus,
} from "./payments";
import { recolorLesson, recolorPaymentLessons } from "./coloring";
import { clearState, getState, setState } from "./botstate";
import { contactKey } from "./link";
import { getOrCreateStudentLinkCode } from "./shortlink";
import { SUBJECTS } from "./config";
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

// Кнопка отмены текущего ввода. force_reply нельзя совместить с инлайн-кнопкой,
// поэтому у приглашений к вводу показываем инлайн-«Отмена» (callback "cancel").
const cancelKb = () => inlineKeyboard([[{ text: "✖️ Отмена", data: "cancel" }]]);

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
  const rows: TgButton[][] = [[{ text: "➕ Новый ученик", data: "newstu" }]];
  for (const s of active) rows.push([{ text: `${s.name} · ${s.subject}`, data: `stu:${s.id}` }]);
  const text = active.length
    ? "<b>👥 Ученики</b>\nВыберите ученика или добавьте нового:"
    : "<b>👥 Ученики</b>\n\nПока пусто. Добавьте первого ученика кнопкой ниже.";
  await emit(chatId, messageId, text, inlineKeyboard(rows));
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
    [{ text: "🔗 Ссылка на запись", data: `slink:${s.id}` }],
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
  const rows: TgButton[][] = [[{ text: "➕ Новый счёт", data: `newp:${s.id}` }]];
  for (const p of pays) {
    if (p.status !== "paid") {
      rows.push([
        { text: `✅ Оплачено ${rub(p.amountKopecks)} ₽`, data: `payp:${p.id}` },
        { text: "🔗 Ссылка", data: `plink:${p.id}` },
      ]);
    }
    rows.push([
      { text: `🗑 Удалить счёт ${rub(p.amountKopecks)} ₽`, data: `delp:${p.id}` },
    ]);
  }
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

// Спрашивает подтверждение удаления счёта (действие необратимо).
export async function promptDeletePayment(
  chatId: number | string,
  messageId: number | null,
  paymentId: string
): Promise<void> {
  const p = await getPayment(paymentId);
  if (!p) {
    await emit(chatId, messageId, "Счёт не найден (возможно, уже удалён).");
    return;
  }
  const text =
    `🗑 <b>Удалить счёт?</b>\n\n${rub(p.amountKopecks)} ₽` +
    `${p.note ? ` · ${escapeHtml(p.note)}` : ""}\n\nДействие необратимо.`;
  const keyboard = inlineKeyboard([
    [
      { text: "❗ Удалить", data: `delpok:${p.id}` },
      { text: "Отмена", data: `pays:${p.studentId}` },
    ],
  ]);
  await emit(chatId, messageId, text, keyboard);
}

// Удаляет счёт и перекрашивает освободившиеся занятия. Возвращает studentId для навигации.
export async function deletePaymentBot(paymentId: string): Promise<string | null> {
  const p = await getPayment(paymentId);
  if (!p) return null;
  // Занятия фиксируем ДО удаления: после удаления связи lesson_payments исчезнут.
  let lessonIds: string[] = [];
  try {
    lessonIds = await lessonIdsForPayment(paymentId);
  } catch (e) {
    console.error("bot delete payment: lessonIds failed", e);
  }
  await deletePayment(paymentId);
  for (const id of lessonIds) {
    try {
      await recolorLesson(id);
    } catch (e) {
      console.error("bot delete payment recolor failed", e);
    }
  }
  return p.studentId;
}

// Базовый URL для ссылок из бота. У бота нет заголовков запроса (в отличие от /admin),
// поэтому берём NEXT_PUBLIC_BASE_URL, а если он пуст/локальный — VERCEL_URL (его Vercel
// всегда проставляет на деплое). Так ссылка соберётся независимо от настройки env.
function botBaseUrl(): string {
  const explicit = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (explicit && !explicit.includes("localhost")) return explicit;
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return explicit; // локальная разработка (напр. http://localhost:3000) либо пусто
}

// Генерирует персональную ссылку на запись (тот же encodeToken, что и /admin) и шлёт её.
// trial=true — ссылка на разовое пробное занятие (иначе — регулярная еженедельная).
export async function sendBookingLink(
  chatId: number | string,
  studentId: string,
  trial = false
): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) {
    await sendOwner("Ученик не найден.");
    return;
  }
  const base = botBaseUrl();
  if (!base) {
    await sendOwner("Не задан адрес сайта (NEXT_PUBLIC_BASE_URL / VERCEL_URL) — ссылку не собрать.");
    return;
  }
  const code = await getOrCreateStudentLinkCode(s.id, trial);
  const url = `${base}/z/${code}`;
  await sendOwner(
    `🔗 <b>Ссылка на запись — ${escapeHtml(s.name)}</b>\n${escapeHtml(s.subject)}${trial ? " · пробное (разовое)" : ""}\n\n<code>${escapeHtml(url)}</code>\n\nОтправьте её ученику.`
  );
}

// ── Мастер добавления нового ученика ──
// имя → предмет (для «Другое» — своё название) → telegram → пробное/регулярное → ссылка.
// Данные шага храним в botState.targetId как JSON, т.к. поле одно.

export async function promptNewStudent(chatId: number | string): Promise<void> {
  await setState(String(chatId), "stu.new.name", "{}");
  await sendOwner("🧑‍🎓 Как зовут нового ученика? Пришлите имя одним сообщением.", cancelKb());
}

// Шаг 2: выбор предмета кнопками (последний пункт «Другое» — со своим названием).
async function askSubject(chatId: number | string, name: string): Promise<void> {
  await setState(String(chatId), "stu.new.subject", JSON.stringify({ name }));
  const rows: TgButton[][] = SUBJECTS.map((s, i) => [{ text: s, data: `nsub:${i}` }]);
  rows.push([{ text: "✖️ Отмена", data: "cancel" }]);
  await sendOwner(`📚 Предмет для <b>${escapeHtml(name)}</b>?`, inlineKeyboard(rows));
}

// Шаг 3: telegram ученика (необязательно). Вызывается после выбора/ввода предмета.
async function askTg(chatId: number | string, name: string, subject: string): Promise<void> {
  await setState(String(chatId), "stu.new.tg", JSON.stringify({ name, subject }));
  await sendOwner(
    "✈️ Telegram ученика — пришлите <code>@username</code> сообщением или нажмите «Пропустить».",
    inlineKeyboard([[{ text: "Пропустить", data: "nskiptg" }, { text: "✖️ Отмена", data: "cancel" }]])
  );
}

// Шаг 4: тип занятий. Вызывается после ввода/пропуска telegram.
async function askTrial(
  chatId: number | string,
  name: string,
  subject: string,
  tg: string
): Promise<void> {
  await setState(String(chatId), "stu.new.trial", JSON.stringify({ name, subject, tg }));
  await sendOwner(
    "🎯 Тип занятий?\n<b>Регулярное</b> — запись повторяется каждую неделю.\n" +
      "<b>Пробное</b> — разовая запись на один день.",
    inlineKeyboard([
      [
        { text: "🔁 Регулярное", data: "ntrial:0" },
        { text: "🎯 Пробное", data: "ntrial:1" },
      ],
      [{ text: "✖️ Отмена", data: "cancel" }],
    ])
  );
}

// Обработка выбора предмета из callback nsub:<i>. «Другое» → просим своё название.
export async function pickSubjectForNew(chatId: number | string, index: number): Promise<void> {
  const st = await getState(String(chatId));
  if (!st || st.action !== "stu.new.subject") {
    await sendOwner("Сессия создания ученика истекла. Начните заново: /new");
    return;
  }
  const subject = SUBJECTS[index];
  if (!subject) {
    await sendOwner("Неизвестный предмет, попробуйте ещё раз.");
    return;
  }
  let name = "";
  try {
    name = JSON.parse(st.targetId).name || "";
  } catch {}
  if (subject === "Другое") {
    await setState(String(chatId), "stu.new.subjcustom", JSON.stringify({ name }));
    await sendOwner("✍️ Напишите название предмета одним сообщением:", cancelKb());
    return;
  }
  await askTg(chatId, name, subject);
}

// Telegram получен (текст или «Пропустить») → переходим к выбору типа занятий.
export async function submitTgForNew(chatId: number | string, tgRaw: string): Promise<void> {
  const st = await getState(String(chatId));
  if (!st || st.action !== "stu.new.tg") {
    await sendOwner("Сессия создания ученика истекла. Начните заново: /new");
    return;
  }
  let name = "";
  let subject = "";
  try {
    const o = JSON.parse(st.targetId);
    name = o.name || "";
    subject = o.subject || "";
  } catch {}
  if (!name || !subject) {
    await clearState(String(chatId));
    await sendOwner("Не хватило данных. Начните заново: /new");
    return;
  }
  const skip = /^(-|нет|пропустить|skip)$/i.test(tgRaw.trim());
  const tg = skip ? "" : tgRaw.trim();
  await askTrial(chatId, name, subject, tg);
}

// Финал (из callback ntrial:<0|1>): создаёт/освежает ученика в БД и шлёт ссылку.
export async function chooseTrialForNew(chatId: number | string, trial: boolean): Promise<void> {
  const st = await getState(String(chatId));
  if (!st || st.action !== "stu.new.trial") {
    await sendOwner("Сессия создания ученика истекла. Начните заново: /new");
    return;
  }
  let name = "";
  let subject = "";
  let tg = "";
  try {
    const o = JSON.parse(st.targetId);
    name = o.name || "";
    subject = o.subject || "";
    tg = o.tg || "";
  } catch {}
  if (!name || !subject) {
    await clearState(String(chatId));
    await sendOwner("Не хватило данных. Начните заново: /new");
    return;
  }
  // trial влияет и на contactKey (как на /admin), и на саму ссылку — держим их согласованными.
  const ck = contactKey({ name, subject, tg, trial });
  const s = await upsertStudent({ name, subject, tg, contactKey: ck });
  await clearState(String(chatId));
  await sendOwner(`✅ Ученик <b>${escapeHtml(name)}</b> добавлен${trial ? " · пробное" : ""}.`);
  await sendBookingLink(chatId, s.id, trial);
  await showStudentCard(chatId, null, s.id);
}

// Отменяет текущий ожидаемый ввод (заметка/счёт/ссылка/новый ученик) и по
// возможности возвращает на предыдущий экран. Вызывается из кнопки «Отмена» и /cancel.
export async function cancelPending(chatId: number | string): Promise<void> {
  const st = await getState(String(chatId));
  await clearState(String(chatId));
  if (!st) {
    await sendOwner("Нечего отменять.");
    return;
  }
  await sendOwner("✖️ Отменено.");
  try {
    if (st.action === "student.note") {
      await showStudentCard(chatId, null, st.targetId);
    } else if (st.action === "lesson.note") {
      const l = await getLesson(st.targetId);
      if (l) await showLessons(chatId, null, l.studentId);
    } else if (st.action === "payment.create") {
      await showPayments(chatId, null, st.targetId);
    } else if (st.action === "payment.link") {
      const p = await getPayment(st.targetId);
      if (p) await showPayments(chatId, null, p.studentId);
    } else if (st.action.startsWith("stu.new")) {
      await showStudentsList(chatId, null);
    }
  } catch (e) {
    console.error("cancelPending navigate failed", e);
  }
}

export async function promptNewPayment(chatId: number | string, studentId: string): Promise<void> {
  await setState(String(chatId), "payment.create", studentId);
  await sendOwner(
    "💳 Пришлите сумму счёта в рублях. Можно с комментарием одной строкой.\nНапример: <code>6000 Март, 4 занятия</code>",
    cancelKb()
  );
}

export async function promptPaymentLink(chatId: number | string, paymentId: string): Promise<void> {
  await setState(String(chatId), "payment.link", paymentId);
  await sendOwner("🔗 Пришлите ссылку на оплату из «Мой налог» для этого счёта:", cancelKb());
}

export async function promptStudentNote(chatId: number | string, studentId: string): Promise<void> {
  await setState(String(chatId), "student.note", studentId);
  await sendOwner("✍️ Пришлите текст заметки об ученике одним сообщением:", cancelKb());
}

export async function promptLessonNote(chatId: number | string, lessonId: string): Promise<void> {
  await setState(String(chatId), "lesson.note", lessonId);
  await sendOwner("✍️ Пришлите текст заметки по занятию одним сообщением:", cancelKb());
}

// Если бот ждёт ввод (заметку) — сохраняет и подтверждает. Возвращает true, если обработал.
export async function applyPendingInput(chatId: number | string, text: string): Promise<boolean> {
  const st = await getState(String(chatId));
  if (!st) return false;
  const value = text.trim();

  if (st.action === "stu.new.name") {
    if (!value) {
      await sendOwner("Имя пустое — пришлите имя ученика.");
      return true;
    }
    await askSubject(chatId, value);
    return true;
  }
  if (st.action === "stu.new.subjcustom") {
    if (!value) {
      await sendOwner("Название пустое — пришлите название предмета.");
      return true;
    }
    let name = "";
    try {
      name = JSON.parse(st.targetId).name || "";
    } catch {}
    await askTg(chatId, name, value);
    return true;
  }
  if (st.action === "stu.new.tg") {
    await submitTgForNew(chatId, value);
    return true;
  }
  if (st.action === "payment.create") {
    // "6000 Март, 4 занятия" → сумма 6000, комментарий "Март, 4 занятия".
    const m = value.match(/^(\d[\d\s]*)\s*(.*)$/s);
    const rubles = m ? Number(m[1].replace(/\s/g, "")) : 0;
    if (!rubles) {
      // Сумму не распознали — просим повторить, состояние сохраняем.
      await sendOwner("Не понял сумму. Пришлите число рублей, например <code>6000</code>.");
      return true;
    }
    await createPayment({
      studentId: st.targetId,
      amountKopecks: rubles * 100,
      note: (m?.[2] || "").trim(),
    });
    await clearState(String(chatId));
    await sendOwner(`✅ Счёт на ${rub(rubles * 100)} ₽ создан. Прикрепите ссылку кнопкой «🔗 Ссылка».`);
    await showPayments(chatId, null, st.targetId);
    return true;
  }
  if (st.action === "payment.link") {
    await setPayLink(st.targetId, value);
    await clearState(String(chatId));
    const p = await getPayment(st.targetId);
    await sendOwner("✅ Ссылка на оплату сохранена.");
    if (p) await showPayments(chatId, null, p.studentId);
    return true;
  }
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
