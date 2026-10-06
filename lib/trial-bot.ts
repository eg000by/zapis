// Пробное занятие за три нажатия: экран свободных окон (текст для родителя
// копируется одним тапом) → время, которое назвал родитель → «Маша ОГЭ».
// Логика записи — в lib/trial.ts; здесь только экраны и шаги диалога.
import {
  editMessageText,
  escapeHtml,
  inlineKeyboard,
  packUuid,
  sendOwner,
  unpackUuid,
  type TgButton,
} from "./telegram";
import { clearState, getState, setState } from "./botstate";
import { SUBJECTS, siteBaseUrl } from "./config";
import { formatMskRange } from "./slots";
import { getOrCreateStudentLinkCode } from "./shortlink";
import { refreshPanel } from "./panel";
import {
  bookTrialByTeacher,
  formatTrialWindows,
  loadTrialDays,
  parseTrialLine,
  undoTrial,
  weekRangeLabel,
} from "./trial";

const CALLBACK_LIMIT = 64;
// Сколько недель вперёд можно листать: дальше расписание всё равно не живёт.
const MAX_OFFSET = 8;

// Экран правится на месте; новое сообщение — только если править нечего.
// Возвращает id сообщения, на котором экран оказался (для следующего шага).
async function emit(
  chatId: number | string,
  messageId: number | null,
  text: string,
  keyboard?: unknown
): Promise<number | null> {
  if (messageId != null && (await editMessageText(chatId, messageId, text, keyboard))) return messageId;
  return (await sendOwner(text, keyboard))?.message_id ?? null;
}

// Время слота в кнопке — минуты от эпохи в base36 (6 символов): ISO-строка в
// callback_data не помещается вместе с остальным, а хранить список слотов в
// состоянии — значит промахнуться, если к нажатию список уже поменялся.
export const packSlot = (iso: string) => Math.round(new Date(iso).getTime() / 60000).toString(36);
export const unpackSlot = (s: string) => {
  const min = parseInt(s, 36);
  return Number.isFinite(min) && min > 0 ? new Date(min * 60000).toISOString() : null;
};

const whenLabel = (iso: string) => formatMskRange(iso, 1);

// Экран окон. offset — неделя (0 — ближайшие 7 дней), all — все свободные, а не
// только рекомендуемые.
export async function showTrialWindows(
  chatId: number | string,
  messageId: number | null,
  offset = 0,
  all = false
): Promise<void> {
  await clearState(String(chatId));
  const now = new Date();
  const o = Math.min(Math.max(0, offset), MAX_OFFSET);
  const days = await loadTrialDays(now, o);
  const f = formatTrialWindows(days, all);
  const range = weekRangeLabel(now, o);

  const head = `🎯 <b>Пробное</b> · ${range}`;
  let body: string;
  if (!f.text) {
    body = `${head}\n\nСвободных окон на эти дни нет — посмотрите следующую неделю.`;
  } else {
    const mode = all
      ? "все свободные"
      : f.fellBack
        ? "рекомендуемых нет — все свободные"
        : `рекомендуемые: ${f.slots.length}`;
    body =
      `${head} · ${mode}\n\n` +
      // <pre> копируется одним тапом целиком — это и есть сообщение родителю.
      `<pre>${escapeHtml(f.text)}</pre>\n` +
      `Родитель выбрал время? Нажмите его ниже — и напишите, кто придёт.`;
  }

  const rows: TgButton[][] = [];
  for (let i = 0; i < f.slots.length; i += 3) {
    rows.push(
      f.slots.slice(i, i + 3).map((s) => {
        const wd = days.find((d) => d.slots.some((x) => x.start === s.start))?.weekday || "";
        return { text: `${wd} ${s.time}`, data: `trs:${o}:${all ? 1 : 0}:${packSlot(s.start)}` };
      })
    );
  }
  const nav: TgButton[] = [];
  if (o > 0) nav.push({ text: "◀️ Раньше", data: `trw:${o - 1}:${all ? 1 : 0}` });
  // Переключатель режима нужен, только когда есть что переключать.
  if (all || !f.fellBack) {
    nav.push({
      text: all ? "★ Рекомендуемые" : "Все свободные",
      data: `trw:${o}:${all ? 0 : 1}`,
    });
  }
  if (o < MAX_OFFSET) nav.push({ text: "Дальше ▶️", data: `trw:${o + 1}:${all ? 1 : 0}` });
  rows.push(nav);
  await emit(chatId, messageId, body, inlineKeyboard(rows));
}

// Нажато время: экран окон превращается в вопрос «кто придёт?».
export async function pickTrialSlot(
  chatId: number | string,
  messageId: number | null,
  data: string // «<offset>:<all>:<packed>»
): Promise<string | null> {
  const [o, a, packed] = data.split(":");
  const start = unpackSlot(packed || "");
  if (!start) return "Время не распознано — откройте 🎯 Пробное заново";
  const id = await emit(
    chatId,
    messageId,
    `🎯 <b>Пробное · ${escapeHtml(whenLabel(start))}</b>\n\n` +
      `Кто придёт? Имя и предмет одной строкой, например <code>Маша ОГЭ</code>.\n` +
      `Можно добавить Telegram: <code>Маша ОГЭ @masha</code>.`,
    inlineKeyboard([[{ text: "⬅️ К окнам", data: `trw:${Number(o) || 0}:${a === "1" ? 1 : 0}` }]])
  );
  await setState(
    String(chatId),
    "trial.who",
    JSON.stringify({ start, o: Number(o) || 0, a: a === "1" }),
    id ?? undefined
  );
  return null;
}

type TrialCtx = { start: string; o: number; a: boolean; name?: string; tg?: string };

function parseCtx(raw: string): TrialCtx | null {
  try {
    const c = JSON.parse(raw);
    return c && typeof c.start === "string" ? c : null;
  } catch {
    return null;
  }
}

// Ввод на шагах пробного. Возвращает true, если обработал.
export async function applyTrialInput(
  chatId: number | string,
  action: string,
  targetId: string,
  value: string,
  promptId: number | null
): Promise<boolean> {
  const ctx = parseCtx(targetId);
  if (!ctx) return false;

  if (action === "trial.who") {
    const p = parseTrialLine(value);
    if (!p.name) {
      await emit(
        chatId,
        promptId,
        `🎯 <b>Пробное · ${escapeHtml(whenLabel(ctx.start))}</b>\n\n` +
          `Не вижу имени. Пришлите, например, <code>Маша ОГЭ</code>.`,
        inlineKeyboard([[{ text: "⬅️ К окнам", data: `trw:${ctx.o}:${ctx.a ? 1 : 0}` }]])
      );
      return true;
    }
    if (!p.subject) {
      await askSubject(chatId, promptId, { ...ctx, name: p.name, tg: p.tg });
      return true;
    }
    await finishBooking(chatId, promptId, { ...ctx, name: p.name, tg: p.tg }, p.subject);
    return true;
  }

  // Предмет не распознали и показали кнопки — но его можно и написать словами
  // («Робототехника»): тогда берём текст как есть.
  if (action === "trial.subj" && ctx.name) {
    if (!value) return true;
    await finishBooking(chatId, promptId, ctx, value);
    return true;
  }
  return false;
}

async function askSubject(chatId: number | string, promptId: number | null, ctx: TrialCtx) {
  const subjects = SUBJECTS.filter((s) => s !== "Другое");
  const rows: TgButton[][] = subjects.map((s, i) => [{ text: s, data: `trsub:${i}` }]);
  rows.push([{ text: "⬅️ К окнам", data: `trw:${ctx.o}:${ctx.a ? 1 : 0}` }]);
  const id = await emit(
    chatId,
    promptId,
    `🎯 <b>Пробное · ${escapeHtml(whenLabel(ctx.start))}</b>\n` +
      `🧑‍🎓 ${escapeHtml(ctx.name || "")}\n\nКакой предмет? Или напишите его сообщением.`,
    inlineKeyboard(rows)
  );
  await setState(String(chatId), "trial.subj", JSON.stringify(ctx), id ?? undefined);
}

// Предмет выбран кнопкой.
export async function chooseTrialSubject(
  chatId: number | string,
  messageId: number | null,
  index: number
): Promise<string | null> {
  const st = await getState(String(chatId));
  const ctx = st?.action === "trial.subj" ? parseCtx(st.targetId) : null;
  const subject = SUBJECTS.filter((s) => s !== "Другое")[index];
  if (!ctx?.name || !subject) return "Выбор устарел — откройте 🎯 Пробное заново";
  await finishBooking(chatId, messageId, ctx, subject);
  return null;
}

async function finishBooking(
  chatId: number | string,
  promptId: number | null,
  ctx: TrialCtx,
  subject: string
): Promise<void> {
  await clearState(String(chatId));
  const r = await bookTrialByTeacher({ startIso: ctx.start, name: ctx.name || "", subject, tg: ctx.tg });
  if (!r.ok) {
    await emit(
      chatId,
      promptId,
      `⚠️ <b>Не записано:</b> ${escapeHtml(r.reason)}\n${escapeHtml(whenLabel(ctx.start))}\n\nВыберите другое время.`,
      inlineKeyboard([[{ text: "🎯 К окнам", data: `trw:${ctx.o}:${ctx.a ? 1 : 0}` }]])
    );
    return;
  }

  // Ссылка на кабинет — отправить родителю: там звонок, напоминания и перенос.
  let link = "";
  const base = siteBaseUrl();
  if (base) {
    try {
      link = `${base}/z/${await getOrCreateStudentLinkCode(r.studentId, true)}`;
    } catch (e) {
      console.error("trial: link failed", e);
    }
  }
  const rows: TgButton[][] = [];
  const undo = `trundo:${r.eventId}:${packUuid(r.studentId)}`;
  rows.push([
    { text: "🧑‍🎓 Карточка", data: `stu:${r.studentId}` },
    // Слишком длинный id события (не наш формат) — кнопку отмены не показываем,
    // иначе Telegram отверг бы весь экран (BUTTON_DATA_INVALID).
    ...(Buffer.byteLength(undo) <= CALLBACK_LIMIT ? [{ text: "↩️ Отменить запись", data: undo }] : []),
  ]);
  rows.push([{ text: "🎯 Ещё пробное", data: "trw:0:0" }]);
  await emit(
    chatId,
    promptId,
    `✅ <b>Пробное записано</b>\n` +
      `🧑‍🎓 ${escapeHtml(r.name)} · ${escapeHtml(r.subject)}\n` +
      `🕒 ${escapeHtml(whenLabel(r.start))}` +
      (link
        ? `\n\n🔗 <code>${escapeHtml(link)}</code>\nСсылка для родителя: звонок, напоминания и перенос.`
        : ""),
    inlineKeyboard(rows)
  );
  // Занятие сегодня — панель дня должна его показать сразу, а не к следующему пульсу.
  await refreshPanel().catch((e) => console.error("trial: panel refresh failed", e));
}

// «↩️ Отменить запись» на экране итога.
export async function undoTrialBot(
  chatId: number | string,
  messageId: number | null,
  data: string // «<eventId>:<packedStudentId>»
): Promise<string> {
  const idx = data.lastIndexOf(":");
  const eventId = data.slice(0, idx);
  const studentId = unpackUuid(data.slice(idx + 1));
  if (!eventId || !studentId) return "Не удалось разобрать запись";
  const { removedStudent } = await undoTrial(eventId, studentId);
  await emit(
    chatId,
    messageId,
    `↩️ <b>Запись отменена</b>${removedStudent ? " · ученик удалён" : ""}`,
    inlineKeyboard([[{ text: "🎯 К окнам", data: "trw:0:0" }]])
  );
  await refreshPanel().catch((e) => console.error("trial undo: panel refresh failed", e));
  return "Отменено";
}
