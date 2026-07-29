import { NextResponse } from "next/server";
import {
  CALENDAR_ID,
  calendarClient,
  fetchBusy,
  isRecurringEvent,
  lessonDescription,
} from "@/lib/google";
import { blockSpanMinutes, formatMskRange, validateSlot, windowBounds } from "@/lib/slots";
import {
  answerCallback,
  editMessageText,
  escapeHtml,
  sendOwner,
  sendTo,
  setMyCommands,
} from "@/lib/telegram";
import { setLessonStatusByEvent, updateLessonByEvent } from "@/lib/lessons";
import { markLessonMissed, recolorStudent, unmarkLessonMissed } from "@/lib/coloring";
import { notifyStudentById, pinStudentLinks } from "@/lib/notify";
import { getStudent, updateStudent } from "@/lib/students";
import {
  applyPendingInput,
  cancelPending,
  chooseTrialForNew,
  deletePaymentBot,
  deleteStudentBot,
  makeStudentFull,
  markPaymentPaid,
  pickSubjectForNew,
  promptDeletePayment,
  promptDeleteStudent,
  promptLessonNote,
  promptNewPayment,
  promptNewStudent,
  promptPaymentLink,
  promptReportLessonNote,
  promptSbpDetails,
  promptStudentMeetLink,
  promptStudentNote,
  renewSeriesBot,
  sendBookingLink,
  setPayMethodBot,
  showDebtors,
  showLessons,
  showPaidHistory,
  showPayments,
  showPaySettings,
  showStats,
  showStudentCard,
  showStudentTools,
  showStudentsList,
  showWeekLoad,
  submitRateForNew,
  submitTgForNew,
  toggleStudentArchive,
} from "@/lib/crm-bot";
import { PENDING_PREFIX, TIMEZONE } from "@/lib/config";
import { ensureAutoInvoices } from "@/lib/autobill";

export const dynamic = "force-dynamic";

const ok = () => NextResponse.json({ ok: true });

// Сверка счетов ученика после отметки занятия (best-effort: сбой БД/ЮKassa не
// должен ломать ответ на кнопку). Внутри — тот же расчёт, что и в кабинете.
async function syncInvoices(studentId: string | null): Promise<void> {
  if (!studentId) return;
  try {
    const s = await getStudent(studentId);
    await ensureAutoInvoices(studentId, s?.name || "");
  } catch (e) {
    console.error("syncInvoices failed", studentId, e);
  }
}

function isOwner(chatId: unknown): boolean {
  const owner = process.env.TELEGRAM_CHAT_ID;
  return !owner || String(chatId) === String(owner);
}

// Webhook Telegram: подтверждение/отклонение заявок + управление CRM (Фаза 4).
export async function POST(req: Request) {
  // Защита webhook секретным токеном (задаётся при setWebhook).
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected && req.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return ok();
  }

  try {
    if (update?.callback_query) return await handleCallback(update.callback_query);
    if (update?.message) return await handleMessage(update.message);
  } catch (e) {
    console.error("telegram handler error", e);
  }
  return ok();
}

async function handleCallback(cq: any): Promise<NextResponse> {
  const data: string = cq.data || "";
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  if (!isOwner(chatId)) {
    await answerCallback(cq.id, "Нет доступа");
    return ok();
  }

  // Отмена текущего ввода (заметка/счёт/ссылка/новый ученик).
  if (data === "cancel") {
    await cancelPending(chatId);
    await answerCallback(cq.id, "Отменено");
    return ok();
  }

  // Навигация CRM.
  if (data === "stus") {
    await showStudentsList(chatId, messageId);
    await answerCallback(cq.id);
    return ok();
  }
  if (data === "stusarch") {
    await showStudentsList(chatId, messageId, true);
    await answerCallback(cq.id);
    return ok();
  }
  if (data === "stats") {
    await showStats(chatId, messageId);
    await answerCallback(cq.id);
    return ok();
  }
  if (data === "load") {
    await showWeekLoad(chatId, messageId);
    await answerCallback(cq.id);
    return ok();
  }
  if (data === "debts") {
    await showDebtors(chatId, messageId);
    await answerCallback(cq.id);
    return ok();
  }
  if (data === "pay") {
    await showPaySettings(chatId, messageId);
    await answerCallback(cq.id);
    return ok();
  }
  // Продление серии из напоминания «занятия скоро закончатся».
  if (data === "renewno") {
    await editMessageText(chatId, messageId, "👌 Ок, напомню ближе к концу серии.");
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("renew:")) {
    const okRenew = await renewSeriesBot(chatId, messageId, data.slice(6));
    await answerCallback(cq.id, okRenew ? "Продлено 🔁" : "Не удалось продлить");
    return ok();
  }
  if (data.startsWith("setpay:")) {
    await setPayMethodBot(chatId, messageId, data.slice(7) === "sbp" ? "sbp" : "yookassa");
    await answerCallback(cq.id, "Способ оплаты обновлён 💳");
    return ok();
  }
  if (data === "sbpedit") {
    await promptSbpDetails(chatId);
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("arch:")) {
    const nowArchived = await toggleStudentArchive(chatId, messageId, data.slice(5));
    await answerCallback(
      cq.id,
      nowArchived == null ? "" : nowArchived ? "В архиве 🗄" : "Снова активен ♻️"
    );
    return ok();
  }
  // Мастер добавления нового ученика.
  if (data === "newstu") {
    await promptNewStudent(chatId);
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("nsub:")) {
    await pickSubjectForNew(chatId, Number(data.slice(5)));
    await answerCallback(cq.id);
    return ok();
  }
  if (data === "nskiptg") {
    await submitTgForNew(chatId, "");
    await answerCallback(cq.id);
    return ok();
  }
  if (data === "nskiprate") {
    await submitRateForNew(chatId, 0);
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("ntrial:")) {
    await chooseTrialForNew(chatId, data.slice(7) === "1");
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("stu:")) {
    await showStudentCard(chatId, messageId, data.slice(4));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("stools:")) {
    await showStudentTools(chatId, messageId, data.slice(7));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("pays:")) {
    await showPayments(chatId, messageId, data.slice(5));
    await answerCallback(cq.id);
    return ok();
  }
  // phist:<studentId>:<страница> — история оплат (всё, что не влезло в карточку).
  if (data.startsWith("phist:")) {
    const [sid, page] = data.slice(6).split(":");
    await showPaidHistory(chatId, messageId, sid, Number(page) || 0);
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("les:")) {
    await showLessons(chatId, messageId, data.slice(4));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("payp:")) {
    const sid = await markPaymentPaid(data.slice(5));
    await answerCallback(cq.id, "Оплата отмечена ✅");
    if (sid) await showPayments(chatId, messageId, sid);
    return ok();
  }
  if (data.startsWith("newp:")) {
    await promptNewPayment(chatId, data.slice(5));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("plink:")) {
    await promptPaymentLink(chatId, data.slice(6));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("slink:")) {
    await sendBookingLink(chatId, data.slice(6));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("delpok:")) {
    const sid = await deletePaymentBot(data.slice(7));
    await answerCallback(cq.id, "Счёт удалён 🗑");
    if (sid) await showPayments(chatId, messageId, sid);
    return ok();
  }
  if (data.startsWith("delp:")) {
    await promptDeletePayment(chatId, messageId, data.slice(5));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("mkfull:")) {
    await makeStudentFull(chatId, messageId, data.slice(7));
    await answerCallback(cq.id, "Теперь полноценный ученик ✅");
    return ok();
  }
  // Утренний отчёт: «Прошло» — подтверждение (и откат ошибочного «Не прошло»),
  // «Не прошло» — серый цвет (пропуск, не тарифицируется).
  if (data.startsWith("ldone:")) {
    const res = await unmarkLessonMissed(data.slice(6));
    // Занятие состоялось — сверяем счета: неоплаченное прошедшее становится долгом.
    await syncInvoices(res.studentId);
    await answerCallback(cq.id, res.found ? "Занятие учтено ✅" : "Занятие не найдено");
    return ok();
  }
  // Заметка к занятию прямо из утреннего отчёта (📝).
  if (data.startsWith("lrep:")) {
    await promptReportLessonNote(chatId, data.slice(5));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("lmiss:")) {
    const res = await markLessonMissed(data.slice(6));
    // Пропуск не тарифицируется — счёт за него (выставленный сразу после занятия)
    // должен уйти, не дожидаясь, пока ученик откроет кабинет.
    await syncInvoices(res.studentId);
    await answerCallback(
      cq.id,
      res.found ? "Пропуск 🚫 — занятие не тарифицируется" : "Занятие не найдено"
    );
    return ok();
  }
  if (data.startsWith("delstuok:")) {
    const done = await deleteStudentBot(data.slice(9));
    await answerCallback(cq.id, done ? "Ученик удалён 🗑" : "Ученик не найден");
    await showStudentsList(chatId, messageId);
    return ok();
  }
  if (data.startsWith("delstu:")) {
    await promptDeleteStudent(chatId, messageId, data.slice(7));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("snote:")) {
    await promptStudentNote(chatId, data.slice(6));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("smeet:")) {
    await promptStudentMeetLink(chatId, data.slice(6));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("lnote:")) {
    await promptLessonNote(chatId, data.slice(6));
    await answerCallback(cq.id);
    return ok();
  }

  // Подтверждение/отклонение переноса (cr:<rev>:<eventId> / dr:<rev>:<eventId>).
  // Ревизия отсекает подтверждение устаревшего уведомления о переносе.
  if (data.startsWith("cr:") || data.startsWith("dr:")) {
    const action = data.slice(0, 1) as "c" | "d";
    const rest = data.slice(3);
    const idx = rest.indexOf(":");
    if (idx > 0) {
      const rev = rest.slice(0, idx);
      const eventId = rest.slice(idx + 1);
      return await handleBookingAction(cq, action, eventId, chatId, messageId, rev);
    }
  }

  // Подтверждение/отклонение заявки (c:/d:).
  const [action, eventId] = splitAction(data);
  if ((action === "c" || action === "d") && eventId) {
    return await handleBookingAction(cq, action, eventId, chatId, messageId);
  }

  await answerCallback(cq.id, "Неизвестная команда");
  return ok();
}

// Единый список команд: из него строится и справка /help, и меню бота (кнопка «/»
// в клиенте Telegram). Меню на стороне Telegram живёт до следующего setMyCommands,
// поэтому обновляем его при каждом /start и /help — иначе после добавления команды
// в меню остаются старые.
const BOT_COMMANDS: { command: string; emoji: string; description: string }[] = [
  { command: "students", emoji: "👥", description: "Ученики, счета, заметки, ссылки" },
  { command: "new", emoji: "➕", description: "Новый ученик + ссылка на запись" },
  { command: "stats", emoji: "📊", description: "Доходы за месяц и всего" },
  { command: "load", emoji: "🗓", description: "Загрузка недели и свободные слоты" },
  { command: "debts", emoji: "🧾", description: "Кто и сколько должен" },
  { command: "pay", emoji: "💳", description: "Способ оплаты (ЮKassa / СБП)" },
  { command: "cancel", emoji: "✖️", description: "Отменить текущий ввод" },
  { command: "help", emoji: "❓", description: "Справка по командам" },
];

const HELP =
  "<b>🤖 Команды</b>\n\n" +
  BOT_COMMANDS.map((c) => `${c.emoji} /${c.command} — ${c.description.toLowerCase()}`).join("\n") +
  "\n\n<b>Внутри карточки ученика:</b>\n" +
  "💳 счета (создать / отметить / удалить) · 📅 занятия и заметки · ⚙️ Ещё (заметка, Телемост, архив, удаление). Ссылка на запись — в тексте карточки.";

// Синхронизация меню команд с текущим списком (best-effort: сбой Telegram API не
// должен ломать ответ на сообщение владельца).
async function refreshBotMenu(): Promise<void> {
  try {
    await setMyCommands(
      BOT_COMMANDS.map((c) => ({ command: c.command, description: `${c.emoji} ${c.description}` }))
    );
  } catch (e) {
    console.error("setMyCommands failed", e);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleMessage(msg: any): Promise<NextResponse> {
  const chatId = msg.chat?.id;
  const text = String(msg.text || "").trim();
  if (!chatId || !text) return ok();

  // Подключение уведомлений учеником: deep-link из кабинета t.me/<бот>?start=<studentId>.
  // Обрабатываем ДО гейта владельца — пишет сам ученик. Payload строго UUID ученика,
  // никаких CRM-возможностей эта ветка не даёт.
  const startPayload = text.startsWith("/start ") ? text.slice(7).trim() : "";
  if (startPayload && UUID_RE.test(startPayload)) {
    const s = await getStudent(startPayload).catch(() => null);
    if (s) {
      await updateStudent(s.id, { tgChatId: String(chatId) });
      await sendTo(
        chatId,
        `🔔 <b>Уведомления подключены</b>\n\nЗдравствуйте, ${escapeHtml(s.name)}! Сюда будут приходить подтверждения записи, напоминания о занятиях и счета на оплату.`
      );
      // Закрепляем в чате ученика его постоянные ссылки (кабинет + Телемост).
      await pinStudentLinks(s, chatId);
    } else {
      await sendTo(chatId, "Ссылка подключения не распознана. Откройте её из личного кабинета ещё раз.");
    }
    return ok();
  }

  if (!isOwner(chatId)) {
    // Ученику (не владельцу) отвечаем только на /start без payload — подсказкой.
    if (text.startsWith("/start")) {
      await sendTo(
        chatId,
        "Это сервисный бот уведомлений о занятиях. Подключение — по кнопке «Уведомления в Telegram» в личном кабинете."
      );
    }
    return ok();
  }

  if (text === "/start") {
    await refreshBotMenu();
    await sendOwner(HELP);
    await showStudentsList(chatId, null);
    return ok();
  }
  if (text.startsWith("/students")) {
    await showStudentsList(chatId, null);
    return ok();
  }
  if (text.startsWith("/stats")) {
    await showStats(chatId, null);
    return ok();
  }
  if (text.startsWith("/load")) {
    await showWeekLoad(chatId, null);
    return ok();
  }
  if (text.startsWith("/debts")) {
    await showDebtors(chatId, null);
    return ok();
  }
  if (text.startsWith("/pay")) {
    await showPaySettings(chatId, null);
    return ok();
  }
  if (text.startsWith("/new")) {
    await promptNewStudent(chatId);
    return ok();
  }
  if (text.startsWith("/help")) {
    await refreshBotMenu();
    await sendOwner(HELP);
    return ok();
  }
  if (text.startsWith("/cancel")) {
    await cancelPending(chatId);
    return ok();
  }

  // Бот ждёт ввод (имя/заметка/сумма/ссылка)?
  if (await applyPendingInput(chatId, text)) return ok();

  if (text.startsWith("/")) {
    await sendOwner(HELP);
  }
  return ok();
}

// Подтверждение/отклонение заявки (существующая логика).
async function handleBookingAction(
  cq: any,
  action: "c" | "d",
  eventId: string,
  chatId: any,
  messageId: number | undefined,
  expectedRev: string | null = null
): Promise<NextResponse> {
  const cal = calendarClient();

  let ev;
  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId });
    ev = res.data;
  } catch {
    await answerCallback(cq.id, "Заявка не найдена (возможно, уже обработана)");
    if (chatId && messageId) {
      await editMessageText(chatId, messageId, "⚠️ Заявка не найдена (возможно, уже обработана).");
    }
    return ok();
  }

  // Устаревшее уведомление: клиент позже перенёс запись на другое время, событие уже
  // сдвинуто. Сверяем ревизию уведомления с текущей ревизией события. Для обычной заявки
  // (без переносов) обе пустые — проверка проходит. Плоская кнопка c:/d: (expectedRev
  // отсутствует) после переноса не совпадёт с rev события и тоже отсечётся.
  {
    const expected = expectedRev ?? "";
    const curRev = String(ev.extendedProperties?.private?.rev || "");
    if (curRev !== expected) {
      const curLessons = Number(ev.extendedProperties?.private?.lessons) || 1;
      const curWhen = ev.start?.dateTime ? formatMskRange(ev.start.dateTime, curLessons) : "";
      await answerCallback(cq.id, "Этот выбор устарел");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          `🔁 <b>Этот выбор переноса устарел</b>\n\nПозже выбрано другое время${curWhen ? `: <b>${escapeHtml(curWhen)}</b>` : ""}.\nПодтвердите актуальное уведомление.`,
          { inline_keyboard: [] }
        );
      }
      return ok();
    }
  }

  // Пользователь мог отменить заявку сам — событие приходит со статусом "cancelled".
  if (ev.status === "cancelled") {
    await answerCallback(cq.id, "Заявку отменил сам пользователь");
    if (chatId && messageId) {
      await editMessageText(
        chatId,
        messageId,
        "🚫 <b>Пользователь отменил эту заявку</b> — подтверждать нечего."
      );
    }
    return ok();
  }

  const priv = ev.extendedProperties?.private || {};
  const student = priv.student || priv.name || "";
  const subject = priv.subject || "";
  const tg = priv.tg || "";
  const lessons =
    Number(priv.lessons) ||
    (ev.start?.dateTime && ev.end?.dateTime
      ? Math.max(
          1,
          Math.round(
            (new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime()) / 3600000
          )
        )
      : 1);
  const when = ev.start?.dateTime ? formatMskRange(ev.start.dateTime, lessons) : "";
  const cleanSummary = (ev.summary || `${student} — ${subject}`).replace(PENDING_PREFIX, "");
  // Разовый перенос одного занятия серии (исключение-инстанс). При отклонении его нельзя
  // удалять (пропало бы занятие той недели) — возвращаем на исходное время.
  const moved = priv.moved === "1";
  const movedTag = moved ? " · разовый перенос" : "";

  try {
    if (action === "c") {
      // Обновляем описание события: убираем «ожидает подтверждения» и добавляем
      // ссылку на Телемост ученика (если она закреплена в его кабинете).
      let meetLink = "";
      if (priv.studentId) {
        try {
          meetLink = (await getStudent(priv.studentId))?.meetLink || "";
        } catch (e) {
          console.error("meetLink lookup (confirm) failed", e);
        }
      }
      // Разовый перенос одной недели — тоже занятие серии: у инстанса-исключения
      // нет recurrence, признак повтора у него — recurringEventId (isRecurringEvent).
      const description = lessonDescription({
        student,
        subject,
        recurring: isRecurringEvent(ev),
        confirmed: true,
        tg,
        meetLink,
      });
      await cal.events.patch({
        calendarId: CALENDAR_ID,
        eventId,
        requestBody: {
          summary: cleanSummary,
          description,
          status: "confirmed",
          extendedProperties: { private: { status: "confirmed" } },
        },
      });
      try {
        await setLessonStatusByEvent(eventId, "confirmed");
        // Пересчитываем цвета всех занятий ученика (баланс оплат × прошлое/будущее).
        if (priv.studentId) await recolorStudent(priv.studentId);
      } catch (e) {
        console.error("CRM lesson status/color (confirm) failed", e);
      }
      await answerCallback(cq.id, "Запись подтверждена ✅");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          `✅ <b>Запись подтверждена</b>${movedTag}\n\n🧑‍🎓 ${student}\n📚 ${subject}\n🕒 ${when}${tg ? `\n✈️ ${tg}` : ""}`
        );
      }
      if (priv.studentId) {
        await notifyStudentById(
          priv.studentId,
          `✅ Ваша запись подтверждена!\n📚 ${escapeHtml(subject)}\n🕒 <b>${escapeHtml(when)}</b>`
        );
      }
    } else if (moved && priv.origStart) {
      // Отклонение разового переноса: возвращаем занятие на исходное время серии.
      // Сначала проверяем, что прежний слот всё ещё свободен (его мог занять другой
      // ученик, пока перенос ждал решения) — иначе получилась бы двойная бронь.
      const now = new Date();
      const { timeMin, timeMax } = windowBounds(now);
      const far = Math.max(
        timeMax.getTime(),
        new Date(priv.origStart).getTime() + blockSpanMinutes(lessons) * 60000
      );
      const busy = await fetchBusy(timeMin, new Date(far + 60000), eventId);
      const v = validateSlot(priv.origStart, busy, now, lessons);
      if (!v.ok) {
        await answerCallback(
          cq.id,
          `Вернуть нельзя: ${v.reason || "прежнее время недоступно"}. Подтвердите перенос или отмените занятие.`
        );
        return ok();
      }
      const oEnd = new Date(new Date(priv.origStart).getTime() + blockSpanMinutes(lessons) * 60000);
      // rev НЕ сбрасываем: счётчик ревизий монотонный на всю жизнь события, иначе
      // старая карточка cr:1 из чата прошла бы анти-stale проверку следующего цикла.
      await cal.events.patch({
        calendarId: CALENDAR_ID,
        eventId,
        requestBody: {
          summary: cleanSummary,
          status: "confirmed",
          start: { dateTime: priv.origStart, timeZone: TIMEZONE },
          end: { dateTime: oEnd.toISOString(), timeZone: TIMEZONE },
          extendedProperties: { private: { status: "confirmed", moved: "", origStart: "" } },
        },
      });
      try {
        if (priv.studentId) await recolorStudent(priv.studentId);
      } catch (e) {
        console.error("CRM color (decline moved) failed", e);
      }
      const origWhen = formatMskRange(priv.origStart, lessons);
      await answerCallback(cq.id, "Перенос отклонён ❌");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          `↩️ <b>Разовый перенос отклонён</b>\n\n🧑‍🎓 ${student}\n📚 ${subject}\nЗанятие осталось на прежнем времени:\n🕒 ${origWhen}`
        );
      }
      if (priv.studentId) {
        await notifyStudentById(
          priv.studentId,
          `↩️ Перенос не согласован — занятие осталось на прежнем времени:\n🕒 <b>${escapeHtml(origWhen)}</b>`
        );
      }
    } else if (priv.prevStart) {
      // Отклонение переноса записи/серии: возвращаем на прежнее время (раньше здесь
      // удалялась вся серия). Проверяем ближайшее будущее наступление прежнего слота —
      // сам DTSTART давно идущей серии может быть в прошлом.
      const isSeries = Array.isArray(ev.recurrence) && ev.recurrence.length > 0;
      const now = new Date();
      const { timeMin, timeMax } = windowBounds(now);
      let f = new Date(priv.prevStart).getTime();
      if (isSeries) {
        while (f <= now.getTime()) f += 7 * 86400000;
      }
      const far = Math.max(timeMax.getTime(), f + blockSpanMinutes(lessons) * 60000);
      const busy = await fetchBusy(timeMin, new Date(far + 60000), eventId);
      const v = validateSlot(new Date(f).toISOString(), busy, now, lessons);
      if (!v.ok) {
        await answerCallback(
          cq.id,
          `Вернуть нельзя: ${v.reason || "прежнее время недоступно"}. Подтвердите перенос или отмените запись.`
        );
        return ok();
      }
      const oEnd = new Date(new Date(priv.prevStart).getTime() + blockSpanMinutes(lessons) * 60000);
      // recurrence не трогаем (RRULE с COUNT остаётся), rev не сбрасываем (монотонный).
      await cal.events.patch({
        calendarId: CALENDAR_ID,
        eventId,
        requestBody: {
          summary: cleanSummary,
          status: "confirmed",
          start: { dateTime: priv.prevStart, timeZone: TIMEZONE },
          end: { dateTime: oEnd.toISOString(), timeZone: TIMEZONE },
          extendedProperties: { private: { status: "confirmed", prevStart: "" } },
        },
      });
      try {
        await updateLessonByEvent(eventId, {
          status: "confirmed",
          occurrenceStart: new Date(priv.prevStart),
        });
        if (priv.studentId) await recolorStudent(priv.studentId);
      } catch (e) {
        console.error("CRM sync (decline reschedule) failed", e);
      }
      const backWhen = `${formatMskRange(new Date(f).toISOString(), lessons)}${isSeries ? " (еженедельно)" : ""}`;
      await answerCallback(cq.id, "Перенос отклонён ❌");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          `↩️ <b>Перенос отклонён</b>\n\n🧑‍🎓 ${student}\n📚 ${subject}\nЗапись осталась на прежнем времени:\n🕒 ${backWhen}`
        );
      }
      if (priv.studentId) {
        await notifyStudentById(
          priv.studentId,
          `↩️ Перенос не согласован — запись осталась на прежнем времени:\n🕒 <b>${escapeHtml(backWhen)}</b>`
        );
      }
    } else {
      await cal.events.delete({ calendarId: CALENDAR_ID, eventId });
      try {
        await setLessonStatusByEvent(eventId, "cancelled");
      } catch (e) {
        console.error("CRM lesson status (decline) failed", e);
      }
      await answerCallback(cq.id, "Заявка отклонена ❌");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          `❌ <b>Заявка отклонена</b>\n\n🧑‍🎓 ${student}\n📚 ${subject}\n🕒 ${when}${tg ? `\n✈️ ${tg}` : ""}`
        );
      }
      if (priv.studentId) {
        await notifyStudentById(
          priv.studentId,
          `❌ К сожалению, запись не подтверждена:\n🕒 ${escapeHtml(when)}\nВыберите, пожалуйста, другое время в личном кабинете.`
        );
      }
    }
  } catch (e) {
    console.error("telegram action error", e);
    await answerCallback(cq.id, "Ошибка при обработке");
  }

  return ok();
}

function splitAction(data: string): [string | null, string | null] {
  const idx = data.indexOf(":");
  if (idx < 0) return [null, null];
  return [data.slice(0, idx), data.slice(idx + 1)];
}
