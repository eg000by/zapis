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
import { deleteStudent, getStudent, listStudents, updateStudent, upsertStudent } from "./students";
import {
  findOrCreateOccurrenceLesson,
  getLesson,
  listStudentLessons,
  setLessonNote,
} from "./lessons";
import {
  applyMeetLinkToEvents,
  CALENDAR_ID,
  calendarClient,
  deleteFutureEventsForContact,
  listContactOccurrences,
} from "./google";
import {
  createPayment,
  deletePayment,
  getPayment,
  listStudentPayments,
  outstandingPayments,
  setPayLink,
  setPaymentStatus,
} from "./payments";
import { markPastLessonsFree, recolorStudent } from "./coloring";
import { clearState, getState, setState } from "./botstate";
import { contactKey } from "./link";
import { getOrCreateStudentLinkCode } from "./shortlink";
import { MISSED_COLOR_ID, SUBJECTS, siteBaseUrl } from "./config";
import { computeIncomeStats } from "./stats";
import { formatMskRange } from "./slots";
import {
  DEFAULT_SBP_DETAILS,
  getPayMethod,
  getSbpDetails,
  setSetting,
  type PayMethod,
} from "./settings";

const rub = (kopecks: number) => (kopecks / 100).toLocaleString("ru-RU");

const PAY_STATUS: Record<string, string> = {
  unpaid: "🔴",
  paid: "🟢",
  canceled: "⚪",
};

// Кнопка отмены текущего ввода. force_reply нельзя совместить с инлайн-кнопкой,
// поэтому у приглашений к вводу показываем инлайн-«Отмена» (callback "cancel").
const cancelKb = () => inlineKeyboard([[{ text: "✖️ Отмена", data: "cancel" }]]);

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
  messageId: number | null,
  archived = false
): Promise<void> {
  const all = await listStudents();
  const active = all.filter((s) => s.active);
  const inArchive = all.filter((s) => !s.active);

  if (archived) {
    const rows: TgButton[][] = inArchive.map((s) => [
      { text: `🗄 ${s.name} · ${s.subject}`, data: `stu:${s.id}` },
    ]);
    rows.push([{ text: "⬅️ Активные", data: "stus" }]);
    const text = inArchive.length
      ? "<b>🗄 Архив</b>\nВыберите ученика, чтобы вернуть его в активные:"
      : "<b>🗄 Архив</b>\n\nАрхив пуст.";
    await emit(chatId, messageId, text, inlineKeyboard(rows));
    return;
  }

  const rows: TgButton[][] = [
    [{ text: "➕ Новый ученик", data: "newstu" }, { text: "📊 Доходы", data: "stats" }],
  ];
  for (const s of active) rows.push([{ text: `${s.name} · ${s.subject}`, data: `stu:${s.id}` }]);
  if (inArchive.length) rows.push([{ text: `🗄 Архив (${inArchive.length})`, data: "stusarch" }]);
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
    `🧑‍🎓 <b>${escapeHtml(s.name)}</b>${s.trial ? " · 🎯 пробный" : ""}${s.active ? "" : " · 🚫 архив"}`,
    `📚 ${escapeHtml(s.subject)}${s.tg ? ` · ${escapeHtml(s.tg)}` : ""}`,
    `💰 ${s.rateKopecks > 0 ? `${rub(s.rateKopecks)} ₽/час` : "ставка не задана"} · долг: <b>${rub(debt)} ₽</b>`,
  ];
  // Ссылка на запись — прямо в тексте карточки (в <code> копируется одним тапом).
  const base = botBaseUrl();
  if (base) {
    try {
      const code = await getOrCreateStudentLinkCode(s.id, s.trial);
      lines.push(`🔗 <code>${escapeHtml(`${base}/z/${code}`)}</code>`);
    } catch (e) {
      console.error("student card link failed", e);
    }
  }
  if (s.meetLink) lines.push(`🎥 ${escapeHtml(s.meetLink)}`);
  if (s.note) lines.push(`📝 ${escapeHtml(s.note)}`);

  const rows: TgButton[][] = [
    [{ text: "💳 Счета", data: `pays:${s.id}` }, { text: "📅 Занятия", data: `les:${s.id}` }],
  ];
  // Пробный переводится в полноценные вручную — когда решишь продолжать занятия.
  if (s.trial) rows.push([{ text: "🎓 Сделать полноценным", data: `mkfull:${s.id}` }]);
  rows.push([{ text: "⚙️ Ещё", data: `stools:${s.id}` }]);
  rows.push([{ text: "⬅️ Все ученики", data: "stus" }]);

  await emit(chatId, messageId, lines.join("\n"), inlineKeyboard(rows));
}

// Статистика доходов: суммы за месяц/прошлый месяц/всё время, долг, мини-график
// по 6 месяцам. Данные — из оплаченных счетов (lib/stats.ts).
export async function showStats(
  chatId: number | string,
  messageId: number | null
): Promise<void> {
  const st = await computeIncomeStats();
  const max = Math.max(1, ...st.byMonth.map((m) => m.kopecks));
  // Мини-график: столбик из блоков высотой пропорционально месяцу.
  const bars = st.byMonth
    .map((m) => {
      const n = m.kopecks === 0 ? 0 : Math.max(1, Math.round((m.kopecks / max) * 8));
      return `${m.label.padEnd(3)} ${"█".repeat(n)}${n === 0 ? "·" : ""} ${rub(m.kopecks)} ₽`;
    })
    .join("\n");
  const text =
    `📊 <b>Доходы</b>\n\n` +
    `За этот месяц: <b>${rub(st.thisMonthKopecks)} ₽</b>\n` +
    (st.expectedMonthKopecks != null
      ? `Ожидается за месяц: <b>${rub(st.expectedMonthKopecks)} ₽</b> (по расписанию)\n`
      : "") +
    `За прошлый месяц: ${rub(st.prevMonthKopecks)} ₽\n` +
    `Всего получено: ${rub(st.totalKopecks)} ₽ (${st.paidCount} оплат)\n` +
    `Не оплачено (выставлено): ${rub(st.outstandingKopecks)} ₽\n` +
    `Активных учеников: ${st.activeStudents}\n\n` +
    `<b>Помесячно</b>\n<code>${bars}</code>`;
  await emit(chatId, messageId, text, inlineKeyboard([[{ text: "⬅️ Ученики", data: "stus" }]]));
}

// Раздел «Способ оплаты» — паритет с /admin: ЮKassa (кнопка-ссылка) или СБП-перевод
// (реквизиты в кабинете, оплата отмечается вручную) + текст реквизитов СБП.
export async function showPaySettings(
  chatId: number | string,
  messageId: number | null
): Promise<void> {
  const method = await getPayMethod().catch(() => "yookassa" as PayMethod);
  const sbp = await getSbpDetails().catch(() => DEFAULT_SBP_DETAILS);
  const text =
    `💳 <b>Способ оплаты</b>\n\n` +
    `Сейчас: <b>${method === "sbp" ? "СБП-перевод" : "ЮKassa (кнопка оплаты)"}</b>\n\n` +
    (method === "sbp"
      ? `Реквизиты, которые видит ученик:\n<code>${escapeHtml(sbp)}</code>`
      : `Ученику показывается кнопка «Оплатить» со ссылкой ЮKassa.`);
  const keyboard = inlineKeyboard([
    [{ text: `${method === "yookassa" ? "✅ " : ""}ЮKassa`, data: "setpay:yookassa" }],
    [{ text: `${method === "sbp" ? "✅ " : ""}СБП-перевод`, data: "setpay:sbp" }],
    [{ text: "✏️ Изменить реквизиты СБП", data: "sbpedit" }],
  ]);
  await emit(chatId, messageId, text, keyboard);
}

// Переключение способа оплаты из бота (тот же setSetting, что и /admin).
export async function setPayMethodBot(
  chatId: number | string,
  messageId: number | null,
  method: PayMethod
): Promise<void> {
  await setSetting("payMethod", method === "sbp" ? "sbp" : "yookassa");
  await showPaySettings(chatId, messageId);
}

// Приглашение изменить реквизиты СБП (forced reply через botState).
export async function promptSbpDetails(chatId: number | string): Promise<void> {
  const cur = await getSbpDetails().catch(() => DEFAULT_SBP_DETAILS);
  await setState(String(chatId), "settings.sbp", "");
  await sendOwner(
    `✏️ Пришлите новый текст реквизитов СБП (его увидит ученик в кабинете).\nТекущий:\n<code>${escapeHtml(cur)}</code>`,
    cancelKb()
  );
}

// Раздел «технических» кнопок карточки — редкие действия не нагружают основной экран.
export async function showStudentTools(
  chatId: number | string,
  messageId: number | null,
  studentId: string
): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) {
    await emit(chatId, messageId, "Ученик не найден.");
    return;
  }
  const keyboard = inlineKeyboard([
    [{ text: "📝 Заметка об ученике", data: `snote:${s.id}` }],
    [{ text: "🎥 Изменить ссылку на Телемост", data: `smeet:${s.id}` }],
    [{ text: s.active ? "🗄 В архив" : "♻️ Вернуть из архива", data: `arch:${s.id}` }],
    [{ text: "🗑 Удалить ученика", data: `delstu:${s.id}` }],
    [{ text: "⬅️ Назад к ученику", data: `stu:${s.id}` }],
  ]);
  await emit(chatId, messageId, `⚙️ <b>${escapeHtml(s.name)} — управление</b>`, keyboard);
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
  const lines = [`💳 <b>Счета — ${escapeHtml(s.name)}</b>`];
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

// Занятия ученика — из КАЛЕНДАРЯ (источник правды): реальные прошедшие и ближайшие
// повторы, с учётом отмен/EXDATE/переносов. Строки БД используются только для заметок
// (матчатся по точному началу занятия). Раньше показывались сырые строки БД — у серии
// там время ПЕРВОГО повтора, даже если сами повторы отменены в календаре.
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
  const occ = await listContactOccurrences(s.contactKey);
  const now = Date.now();
  const past = occ.filter((o) => o.start.getTime() < now).slice(-3);
  const future = occ.filter((o) => o.start.getTime() >= now).slice(0, 3);

  // Заметки из БД — по точному времени начала занятия.
  const notes = new Map<number, string>();
  try {
    for (const l of await listStudentLessons(s.id, 100)) {
      if (l.note && l.occurrenceStart) notes.set(new Date(l.occurrenceStart).getTime(), l.note);
    }
  } catch (e) {
    console.error("showLessons notes failed", e);
  }

  const lines = [`📅 <b>Занятия — ${escapeHtml(s.name)}</b>`];
  const fmt = (o: (typeof occ)[number]) => formatMskRange(o.start.toISOString(), o.hours);
  const noteLine = (o: (typeof occ)[number]) => {
    const n = notes.get(o.start.getTime());
    return n ? `\n   📝 ${escapeHtml(n)}` : "";
  };
  if (past.length) {
    lines.push("\n<b>Прошедшие:</b>");
    for (const o of past) {
      const missed = o.colorId === MISSED_COLOR_ID;
      lines.push(`${missed ? "🚫" : "✔️"} ${fmt(o)}${missed ? " · пропуск" : ""}${noteLine(o)}`);
    }
  }
  if (future.length) {
    lines.push("\n<b>Ближайшие:</b>");
    for (const o of future) lines.push(`▫️ ${fmt(o)}${noteLine(o)}`);
  }
  if (!past.length && !future.length) lines.push("\nПока нет занятий.");

  // Заметку пишем к прошедшим (кнопка на каждое) — тот же поток, что 📝 в опросе.
  const rows: TgButton[][] = past.map((o) => [{ text: `📝 ${fmt(o)}`, data: `lrep:${o.instanceId}` }]);
  rows.push([{ text: "⬅️ Назад", data: `stu:${s.id}` }]);
  await emit(chatId, messageId, lines.join("\n"), inlineKeyboard(rows));
}

// Отмечает счёт оплаченным и пересчитывает цвета занятий ученика по балансу оплат.
// Возвращает studentId для навигации.
export async function markPaymentPaid(paymentId: string): Promise<string | null> {
  const p = await getPayment(paymentId);
  if (!p) return null;
  await setPaymentStatus(paymentId, "paid");
  const s = await getStudent(p.studentId);
  try {
    await recolorStudent(p.studentId);
  } catch (e) {
    console.error("bot markPaid recolor failed", e);
  }
  // Без ставки число оплаченных занятий не посчитать — подскажем.
  if (s && s.rateKopecks <= 0) {
    await sendOwner(
      "ℹ️ Оплату отметил, но цвета не расставлены: не задана ставка ₽/час. Задайте её на /admin, чтобы считать оплаченные занятия."
    );
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

// Удаляет счёт и пересчитывает цвета занятий ученика (баланс уменьшился).
// Возвращает studentId для навигации.
export async function deletePaymentBot(paymentId: string): Promise<string | null> {
  const p = await getPayment(paymentId);
  if (!p) return null;
  await deletePayment(paymentId);
  try {
    await recolorStudent(p.studentId);
  } catch (e) {
    console.error("bot delete payment recolor failed", e);
  }
  return p.studentId;
}

// Спрашивает подтверждение удаления ученика (необратимо, каскадом уходят занятия/оплаты/ссылки).
export async function promptDeleteStudent(
  chatId: number | string,
  messageId: number | null,
  studentId: string
): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) {
    await emit(chatId, messageId, "Ученик не найден (возможно, уже удалён).");
    return;
  }
  let lessonsCount = 0;
  let paysCount = 0;
  try {
    lessonsCount = (await listStudentLessons(s.id, 1000)).length;
    paysCount = (await listStudentPayments(s.id)).length;
  } catch (e) {
    console.error("promptDeleteStudent counts failed", e);
  }
  const text =
    `🗑 <b>Удалить ученика?</b>\n\n🧑‍🎓 ${escapeHtml(s.name)} · ${escapeHtml(s.subject)}\n` +
    `Вместе с ним удалятся: занятий — ${lessonsCount}, счетов — ${paysCount}, ссылка на запись.\n` +
    `События в Google Calendar останутся.\n\n<b>Действие необратимо.</b>`;
  const keyboard = inlineKeyboard([
    [
      { text: "❗ Удалить навсегда", data: `delstuok:${s.id}` },
      { text: "Отмена", data: `stu:${s.id}` },
    ],
  ]);
  await emit(chatId, messageId, text, keyboard);
}

// Переключает архив/активность ученика и перерисовывает карточку. Возвращает
// новое состояние (true = теперь в архиве) или null, если ученик не найден.
export async function toggleStudentArchive(
  chatId: number | string,
  messageId: number | null,
  studentId: string
): Promise<boolean | null> {
  const s = await getStudent(studentId);
  if (!s) {
    await emit(chatId, messageId, "Ученик не найден.");
    return null;
  }
  const nowArchived = s.active; // был активен → уходит в архив
  await updateStudent(studentId, { active: !s.active });
  await showStudentCard(chatId, messageId, studentId);
  return nowArchived;
}

// Удаляет ученика из БД (каскад) и его будущие непроведённые занятия из календаря.
// Возвращает true при успехе — для навигации в список.
export async function deleteStudentBot(studentId: string): Promise<boolean> {
  const s = await getStudent(studentId);
  if (!s) return false;
  try {
    await deleteFutureEventsForContact(s.contactKey);
  } catch (e) {
    console.error("deleteStudentBot: calendar cleanup failed", e);
  }
  await deleteStudent(studentId);
  return true;
}

// Базовый URL для ссылок из бота. У бота нет заголовков запроса (в отличие от /admin),
// поэтому берём его из env — общая логика в lib/config.ts (siteBaseUrl).
function botBaseUrl(): string {
  return siteBaseUrl();
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
// имя → предмет (для «Другое» — своё название) → telegram → ставка ₽/час →
// пробное/регулярное → ссылка. Данные шага храним в botState.targetId как JSON.

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

// Шаг 4: ставка за час. Без неё не считаются баланс, автосчета и покраска —
// поэтому спрашиваем сразу при создании (пропустить можно, задать позже в /admin).
async function askRate(
  chatId: number | string,
  name: string,
  subject: string,
  tg: string
): Promise<void> {
  await setState(String(chatId), "stu.new.rate", JSON.stringify({ name, subject, tg }));
  await sendOwner(
    "💰 Ставка за час, ₽ — пришлите число, например <code>1500</code>.\nОт ставки считаются баланс, долг и автосчета.",
    inlineKeyboard([[{ text: "Пропустить", data: "nskiprate" }, { text: "✖️ Отмена", data: "cancel" }]])
  );
}

// Шаг 5: тип занятий. Вызывается после ввода/пропуска ставки.
async function askTrial(
  chatId: number | string,
  name: string,
  subject: string,
  tg: string,
  rateKopecks: number
): Promise<void> {
  await setState(String(chatId), "stu.new.trial", JSON.stringify({ name, subject, tg, rateKopecks }));
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

// Telegram получен (текст или «Пропустить») → переходим к ставке.
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
  await askRate(chatId, name, subject, tg);
}

// Ставка получена (текст-число либо кнопка «Пропустить» → rubles=0) → к типу занятий.
export async function submitRateForNew(chatId: number | string, rubles: number): Promise<void> {
  const st = await getState(String(chatId));
  if (!st || st.action !== "stu.new.rate") {
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
  await askTrial(chatId, name, subject, tg, Math.max(0, Math.round(rubles)) * 100);
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
  let rateKopecks = 0;
  try {
    const o = JSON.parse(st.targetId);
    name = o.name || "";
    subject = o.subject || "";
    tg = o.tg || "";
    rateKopecks = Number(o.rateKopecks) || 0;
  } catch {}
  if (!name || !subject) {
    await clearState(String(chatId));
    await sendOwner("Не хватило данных. Начните заново: /new");
    return;
  }
  // trial влияет и на contactKey (как на /admin), и на саму ссылку — держим их согласованными.
  const ck = contactKey({ name, subject, tg, trial });
  const s = await upsertStudent({ name, subject, tg, contactKey: ck, trial, rateKopecks });
  await clearState(String(chatId));
  await sendOwner(
    `✅ Ученик <b>${escapeHtml(name)}</b> добавлен${trial ? " · пробное" : ""}${
      rateKopecks > 0 ? ` · ${rub(rateKopecks)} ₽/час` : ""
    }.`
  );
  await sendBookingLink(chatId, s.id, trial);
  await showStudentCard(chatId, null, s.id);
}

// Завершает перевод в полноценные: снимает trial, помечает прошедшее пробное
// бесплатным (не долг), пересчитывает цвета и шлёт регулярную ссылку на запись.
async function finalizeMkfull(chatId: number | string, s: { id: string; name: string; contactKey: string; rateKopecks: number }): Promise<void> {
  await updateStudent(s.id, { trial: false });
  try {
    await markPastLessonsFree(s.contactKey);
    await recolorStudent(s.id);
  } catch (e) {
    console.error("finalizeMkfull free/recolor failed", e);
  }
  await sendOwner(
    `✅ <b>${escapeHtml(s.name)}</b> — теперь полноценный ученик${
      s.rateKopecks > 0 ? ` · ${rub(s.rateKopecks)} ₽/час` : ""
    }.\nПрошедшее пробное занятие отмечено бесплатным. Сейчас пришлю регулярную ссылку.`
  );
  await sendBookingLink(chatId, s.id, false);
}

// Переводит пробного ученика в полноценные (кнопка «Сделать полноценным»). Если ставка
// ещё не задана — сперва спрашивает её (баланс и счета считаются от ставки), иначе
// переводит сразу.
export async function makeStudentFull(
  chatId: number | string,
  messageId: number | null,
  studentId: string
): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) {
    await emit(chatId, messageId, "Ученик не найден (возможно, уже удалён).");
    return;
  }
  if (s.rateKopecks > 0) {
    if (messageId != null) {
      await editMessageText(chatId, messageId, `🎓 Перевод в полноценные: <b>${escapeHtml(s.name)}</b>`);
    }
    await finalizeMkfull(chatId, s);
    return;
  }
  // Без ставки — спрашиваем её, перевод завершим после ввода (applyPendingInput).
  await setState(String(chatId), "stu.mkfull.rate", s.id);
  await sendOwner(
    `🎓 Перевод <b>${escapeHtml(s.name)}</b> в полноценные.\n💰 Пришлите ставку за час, ₽ — например <code>1500</code>. От неё считаются баланс и счета.`,
    cancelKb()
  );
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
    if (st.action === "student.note" || st.action === "student.meetlink") {
      await showStudentCard(chatId, null, st.targetId);
    } else if (st.action === "lesson.note") {
      const l = await getLesson(st.targetId);
      if (l) await showLessons(chatId, null, l.studentId);
    } else if (st.action === "payment.create") {
      await showPayments(chatId, null, st.targetId);
    } else if (st.action === "payment.link") {
      const p = await getPayment(st.targetId);
      if (p) await showPayments(chatId, null, p.studentId);
    } else if (st.action === "stu.mkfull.rate") {
      await showStudentCard(chatId, null, st.targetId);
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

// Постоянная ссылка Яндекс Телемоста — закрепляется в кабинете ученика (паритет с /admin).
export async function promptStudentMeetLink(
  chatId: number | string,
  studentId: string
): Promise<void> {
  await setState(String(chatId), "student.meetlink", studentId);
  await sendOwner(
    "🎥 Пришлите постоянную ссылку Яндекс Телемоста (https://telemost.yandex.ru/j/…) — она закрепится в кабинете ученика.\nЧтобы убрать ссылку, пришлите <code>-</code>.",
    cancelKb()
  );
}

export async function promptLessonNote(chatId: number | string, lessonId: string): Promise<void> {
  await setState(String(chatId), "lesson.note", lessonId);
  await sendOwner("✍️ Пришлите текст заметки по занятию одним сообщением:", cancelKb());
}

// Заметка из утреннего отчёта (кнопка 📝 у занятия): по инстансу календаря находим/
// создаём строку занятия в БД и включаем обычный ввод заметки (lesson.note).
export async function promptReportLessonNote(
  chatId: number | string,
  instanceId: string
): Promise<void> {
  const cal = calendarClient();
  let ev;
  try {
    ev = (await cal.events.get({ calendarId: CALENDAR_ID, eventId: instanceId })).data;
  } catch {
    await sendOwner("Занятие не найдено в календаре (возможно, удалено).");
    return;
  }
  const priv = ev.extendedProperties?.private || {};
  const start = ev.start?.dateTime || ev.start?.date;
  if (!priv.studentId || !start) {
    await sendOwner("У занятия нет привязки к ученику — добавьте заметку из карточки: /students.");
    return;
  }
  const lesson = await findOrCreateOccurrenceLesson({
    studentId: priv.studentId,
    calendarEventId: instanceId,
    occurrenceStart: new Date(start),
    subject: priv.subject || null,
  });
  await setState(String(chatId), "lesson.note", lesson.id);
  const when = formatMskRange(new Date(start).toISOString(), Number(priv.lessons) || 1);
  await sendOwner(
    `✍️ Заметка к занятию <b>${escapeHtml(when)}</b>${lesson.note ? `\nСейчас: «${escapeHtml(lesson.note)}»` : ""} — пришлите текст одним сообщением:`,
    cancelKb()
  );
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
  if (st.action === "stu.new.rate") {
    const rubles = Number(value.replace(/\s/g, ""));
    if (!Number.isFinite(rubles) || rubles < 0) {
      await sendOwner("Не понял ставку. Пришлите число рублей за час, например <code>1500</code>.");
      return true;
    }
    await submitRateForNew(chatId, rubles);
    return true;
  }
  if (st.action === "stu.mkfull.rate") {
    const rubles = Number(value.replace(/\s/g, ""));
    if (!Number.isFinite(rubles) || rubles <= 0) {
      await sendOwner("Нужна ставка числом рублей за час, например <code>1500</code>.");
      return true;
    }
    const target = st.targetId;
    await updateStudent(target, { rateKopecks: Math.round(rubles) * 100 });
    await clearState(String(chatId));
    const fresh = await getStudent(target);
    if (fresh) await finalizeMkfull(chatId, fresh);
    else await sendOwner("Ученик не найден.");
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
  if (st.action === "settings.sbp") {
    if (!value) {
      await sendOwner("Текст пустой — пришлите реквизиты СБП.");
      return true;
    }
    await setSetting("sbpDetails", value);
    await clearState(String(chatId));
    await sendOwner("✅ Реквизиты СБП обновлены.");
    await showPaySettings(chatId, null);
    return true;
  }
  if (st.action === "student.note") {
    await updateStudent(st.targetId, { note: value });
    await clearState(String(chatId));
    await sendOwner("✅ Заметка об ученике сохранена.");
    await showStudentCard(chatId, null, st.targetId);
    return true;
  }
  if (st.action === "student.meetlink") {
    const clear = /^(-|нет|удалить)$/i.test(value);
    if (!clear && !/^https?:\/\//i.test(value)) {
      // Похоже, это не ссылка — просим повторить, состояние сохраняем.
      await sendOwner("Это не похоже на ссылку. Пришлите адрес вида <code>https://telemost.yandex.ru/j/…</code> или <code>-</code>, чтобы убрать.");
      return true;
    }
    await updateStudent(st.targetId, { meetLink: clear ? "" : value });
    // Обновляем ссылку и в описании уже существующих событий календаря (best-effort).
    try {
      const s = await getStudent(st.targetId);
      if (s) await applyMeetLinkToEvents(s.contactKey, clear ? "" : value);
    } catch (e) {
      console.error("applyMeetLinkToEvents (bot) failed", e);
    }
    await clearState(String(chatId));
    await sendOwner(clear ? "✅ Ссылка Телемоста убрана." : "✅ Ссылка Телемоста закреплена в кабинете ученика.");
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
