// Пробное занятие за три нажатия: экран свободных окон (текст для родителя
// копируется одним тапом) → время, которое назвал родитель → «Маша ОГЭ».
// Логика записи — в lib/trial.ts; здесь только экраны и шаги диалога.
import { escapeHtml, inlineKeyboard, packUuid, unpackUuid, type TgButton } from "./telegram";
import { clearState, getState, setState } from "./botstate";
import { SUBJECTS, siteBaseUrl } from "./config";
import { formatMskRange } from "./slots";
import { getOrCreateStudentLinkCode } from "./shortlink";
import { refreshPanel } from "./panel";
import { emit } from "./screen";
import {
  bookTrialByTeacher,
  formatTrialWindows,
  loadTrialDays,
  normalizeSubject,
  parseTrialLine,
  undoTrial,
  weekRangeLabel,
} from "./trial";

const CALLBACK_LIMIT = 64;
// Сколько недель вперёд можно листать: дальше расписание всё равно не живёт.
const MAX_OFFSET = 8;
// Предметы для кнопок: «Другое» не нужно — свой предмет пишут словами.
const SUBJECT_BUTTONS = SUBJECTS.filter((s) => s !== "Другое");

// Время слота в кнопке — минуты от эпохи в base36 (6 символов): ISO-строка в
// callback_data не помещается вместе с остальным, а хранить список слотов в
// состоянии — значит промахнуться, если к нажатию список уже поменялся.
export const packSlot = (iso: string) => Math.round(new Date(iso).getTime() / 60000).toString(36);
export const unpackSlot = (s: string) => {
  const min = parseInt(s, 36);
  return Number.isFinite(min) && min > 0 ? new Date(min * 60000).toISOString() : null;
};

const whenLabel = (iso: string) => formatMskRange(iso, 1);
const backToWindows = (o: number, a: boolean): TgButton => ({
  text: "⬅️ К окнам",
  data: `trw:${o}:${a ? 1 : 0}`,
});

type TrialCtx = { start: string; o: number; a: boolean; name?: string; tg?: string; subject?: string };

function parseCtx(raw: string): TrialCtx | null {
  try {
    const c = JSON.parse(raw);
    return c && typeof c.start === "string" ? c : null;
  } catch {
    return null;
  }
}

// Экран окон. offset — страница из 7 дат (0 — с сегодня), all — все свободные, а
// не только рекомендуемые.
export async function showTrialWindows(
  chatId: number | string,
  messageId: number | null,
  offset = 0,
  all = false
): Promise<void> {
  // Сбрасываем только диалог пробного: старая кнопка «К окнам» не должна молча
  // обрывать начатый в это время ввод счёта или заметки.
  const st = await getState(String(chatId)).catch(() => null);
  if (st?.action.startsWith("trial.")) await clearState(String(chatId));

  const now = new Date();
  const o = Math.min(Math.max(0, offset), MAX_OFFSET);
  const days = await loadTrialDays(now, o);
  const f = formatTrialWindows(days, all);
  const head = `🎯 <b>Пробное</b> · ${weekRangeLabel(now, o)}`;

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

  // На кнопке — день недели, ЧИСЛО и время: на странице бывают две «субботы»
  // (сегодняшняя и через неделю), и без числа их не отличить.
  const label = new Map<string, string>();
  for (const d of days) for (const s of d.slots) label.set(s.start, `${d.weekday} ${d.day} · ${s.time}`);
  const rows: TgButton[][] = [];
  for (let i = 0; i < f.slots.length; i += 3) {
    rows.push(
      f.slots.slice(i, i + 3).map((s) => ({
        text: label.get(s.start) || s.time,
        data: `trs:${o}:${all ? 1 : 0}:${packSlot(s.start)}`,
      }))
    );
  }
  const nav: TgButton[] = [];
  if (o > 0) nav.push({ text: "◀️ Раньше", data: `trw:${o - 1}:${all ? 1 : 0}` });
  // Переключатель режима нужен, только когда есть что переключать.
  if (all || !f.fellBack) {
    nav.push({ text: all ? "★ Рекомендуемые" : "Все свободные", data: `trw:${o}:${all ? 0 : 1}` });
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
  const ctx: TrialCtx = { start, o: Number(o) || 0, a: a === "1" };
  const id = await emit(
    chatId,
    messageId,
    `🎯 <b>Пробное · ${escapeHtml(whenLabel(start))}</b>\n\n` +
      `Кто придёт? Имя и предмет одной строкой, например <code>Маша ОГЭ</code>.\n` +
      `Можно добавить Telegram: <code>Маша ОГЭ @masha</code>.`,
    inlineKeyboard([[backToWindows(ctx.o, ctx.a)]])
  );
  await setState(String(chatId), "trial.who", JSON.stringify(ctx), id ?? undefined);
  return null;
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
        inlineKeyboard([[backToWindows(ctx.o, ctx.a)]])
      );
      return true;
    }
    const next = { ...ctx, name: p.name, tg: p.tg };
    if (!p.subject) await askSubject(chatId, promptId, next);
    else await finishBooking(chatId, promptId, { ...next, subject: p.subject });
    return true;
  }

  // Предмет не распознали и показали кнопки — но его можно и написать словами.
  // «огэ» превращается в «ОГЭ информатика», как и в первой строке, — иначе вышел
  // бы второй ученик с тем же именем.
  if (action === "trial.subj" && ctx.name) {
    if (value) await finishBooking(chatId, promptId, { ...ctx, subject: normalizeSubject(value) });
    return true;
  }
  return false;
}

async function askSubject(chatId: number | string, promptId: number | null, ctx: TrialCtx) {
  // Кнопка предмета несёт время своей записи: нажатие на старом экране (другая
  // запись успела начаться) распознаётся как устаревшее, а не записывает не того.
  const slot = packSlot(ctx.start);
  const rows: TgButton[][] = SUBJECT_BUTTONS.map((s, i) => [{ text: s, data: `trsub:${i}:${slot}` }]);
  rows.push([backToWindows(ctx.o, ctx.a)]);
  const id = await emit(
    chatId,
    promptId,
    `🎯 <b>Пробное · ${escapeHtml(whenLabel(ctx.start))}</b>\n` +
      `🧑‍🎓 ${escapeHtml(ctx.name || "")}\n\nКакой предмет? Или напишите его сообщением.`,
    inlineKeyboard(rows)
  );
  await setState(String(chatId), "trial.subj", JSON.stringify(ctx), id ?? undefined);
}

// Предмет выбран кнопкой («<index>:<packed slot>»).
export async function chooseTrialSubject(
  chatId: number | string,
  messageId: number | null,
  data: string
): Promise<string | null> {
  const [i, slot] = data.split(":");
  const st = await getState(String(chatId));
  const ctx = st?.action === "trial.subj" ? parseCtx(st.targetId) : null;
  const subject = SUBJECT_BUTTONS[Number(i)];
  if (!ctx?.name || !subject || unpackSlot(slot || "") !== ctx.start) {
    return "Этот выбор устарел — откройте 🎯 Пробное заново";
  }
  await finishBooking(chatId, messageId, { ...ctx, subject });
  return null;
}

// «Такой ученик уже есть»: записать ему разовое занятие или вернуться к вводу.
export async function confirmExistingTrial(
  chatId: number | string,
  messageId: number | null
): Promise<string | null> {
  const st = await getState(String(chatId));
  const ctx = st?.action === "trial.exists" ? parseCtx(st.targetId) : null;
  if (!ctx?.name || !ctx.subject) return "Этот выбор устарел — откройте 🎯 Пробное заново";
  await finishBooking(chatId, messageId, ctx, true);
  return null;
}

async function finishBooking(
  chatId: number | string,
  promptId: number | null,
  ctx: TrialCtx,
  toExisting = false
): Promise<void> {
  await clearState(String(chatId));
  let r;
  try {
    r = await bookTrialByTeacher({
      startIso: ctx.start,
      name: ctx.name || "",
      subject: ctx.subject || "",
      tg: ctx.tg,
      toExisting,
    });
  } catch (e) {
    // Сбой базы или календаря: экран не должен застыть на «Кто придёт?».
    console.error("trial: booking failed", e);
    r = { ok: false as const, code: "error" as const, reason: "сбой — попробуйте ещё раз" };
  }

  if (!r.ok && r.code === "exists") {
    const id = await emit(
      chatId,
      promptId,
      `🎯 <b>Пробное · ${escapeHtml(whenLabel(ctx.start))}</b>\n\n` +
        `🧑‍🎓 ${escapeHtml(r.reason)}.\n` +
        `Записать ему разовое занятие на это время? Если это другой ученик — допишите фамилию.`,
      inlineKeyboard([
        [{ text: "✅ Записать ему", data: "trex" }],
        [{ text: "✏️ Другой ученик", data: `trs:${ctx.o}:${ctx.a ? 1 : 0}:${packSlot(ctx.start)}` }],
        [backToWindows(ctx.o, ctx.a)],
      ])
    );
    await setState(String(chatId), "trial.exists", JSON.stringify(ctx), id ?? undefined);
    return;
  }
  if (!r.ok) {
    await emit(
      chatId,
      promptId,
      `⚠️ <b>Не записано:</b> ${escapeHtml(r.reason)}\n${escapeHtml(whenLabel(ctx.start))}`,
      inlineKeyboard([[backToWindows(ctx.o, ctx.a)]])
    );
    return;
  }

  // Ссылка на кабинет — отправить родителю: там звонок, напоминания и перенос.
  let link = "";
  const base = siteBaseUrl();
  if (base) {
    try {
      link = `${base}/z/${await getOrCreateStudentLinkCode(r.studentId, r.trial)}`;
    } catch (e) {
      console.error("trial: link failed", e);
    }
  }
  const undo = `trundo:${r.eventId}:${packUuid(r.studentId)}`;
  const rows: TgButton[][] = [
    [
      { text: "🧑‍🎓 Карточка", data: `stu:${r.studentId}` },
      // Слишком длинный id события (не наш формат) — кнопку отмены не показываем,
      // иначе Telegram отверг бы весь экран (BUTTON_DATA_INVALID).
      ...(Buffer.byteLength(undo) <= CALLBACK_LIMIT ? [{ text: "↩️ Отменить запись", data: undo }] : []),
    ],
    [{ text: "🎯 Ещё пробное", data: "trw:0:0" }],
  ];
  await emit(
    chatId,
    promptId,
    `✅ <b>${r.trial ? "Пробное записано" : "Занятие записано"}</b>\n` +
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

// «↩️ Отменить запись» на экране итога. Возвращает текст всплывающего ответа.
export async function undoTrialBot(
  chatId: number | string,
  messageId: number | null,
  data: string // «<eventId>:<packedStudentId>»
): Promise<string> {
  const idx = data.lastIndexOf(":");
  const eventId = idx > 0 ? data.slice(0, idx) : "";
  const studentId = idx > 0 ? unpackUuid(data.slice(idx + 1)) : "";
  if (!eventId || !studentId) return "Не удалось разобрать запись";
  const r = await undoTrial(eventId, studentId);
  // Отказ (занятие уже началось, календарь не ответил) — экран итога не трогаем:
  // запись по-прежнему в силе, и это должно оставаться видно.
  if (!r.ok) return r.reason;
  await emit(
    chatId,
    messageId,
    `↩️ <b>Запись отменена</b>${r.removedStudent ? " · ученик удалён" : ""}`,
    inlineKeyboard([[{ text: "🎯 К окнам", data: "trw:0:0" }]])
  );
  await refreshPanel().catch((e) => console.error("trial undo: panel refresh failed", e));
  return "Отменено";
}
