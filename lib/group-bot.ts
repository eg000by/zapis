// Управление группами из Telegram. Отдельный модуль, а не ещё пятьсот строк в
// crm-bot.ts: у групп своя сущность, свои экраны и свой мастер создания.
//
// Расписание группы ставит преподаватель — у учеников сетки записи нет вовсе
// (время общее на четверых, один участник не может его выбрать или подвинуть).
// Поэтому время выбирается прямо здесь: день недели → свободный час → серия.
import {
  editMessageText,
  escapeHtml,
  inlineKeyboard,
  sendOwner,
  type TgButton,
} from "./telegram";
import {
  GROUP_LIMIT,
  addToGroup,
  createGroup,
  deleteGroup,
  getGroup,
  listGroupMembers,
  listGroups,
  removeFromGroup,
  setGroupMeetLink,
  updateGroup,
} from "./groups";
import { listStudents } from "./students";
import { clearState, getState, setState } from "./botstate";
import {
  CALENDAR_ID,
  calendarClient,
  deleteFutureEventsForContact,
  fetchBusy,
  lessonDescription,
  nextOccurrenceForContact,
} from "./google";
import { buildRecurrence, buildWeek, formatMsk, weekWindowBounds } from "./slots";
import { RECURRENCE_WEEKS, SUBJECTS, TIMEZONE } from "./config";
import { getOrCreateStudentLinkCode } from "./shortlink";

const rub = (kopecks: number) => (kopecks / 100).toLocaleString("ru-RU");
const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

async function emit(
  chatId: number | string,
  messageId: number | null,
  text: string,
  keyboard?: unknown
): Promise<void> {
  if (messageId != null) await editMessageText(chatId, messageId, text, keyboard);
  else await sendOwner(text, keyboard);
}

export async function showGroupsList(
  chatId: number | string,
  messageId: number | null
): Promise<void> {
  const groups = await listGroups();
  const rows: TgButton[][] = [[{ text: "➕ Новая группа", data: "grpnew" }]];
  for (const g of groups) {
    const n = (await listGroupMembers(g.id)).filter((m) => m.active).length;
    rows.push([{ text: `${g.name} · ${n}/${GROUP_LIMIT}`, data: `grp:${g.id}` }]);
  }
  rows.push([{ text: "⬅️ Ученики", data: "stus" }]);
  await emit(
    chatId,
    messageId,
    groups.length
      ? "<b>👥 Группы</b>\nЗанятие одно на всех, деньги и кабинет — у каждого свои."
      : "<b>👥 Группы</b>\n\nПока пусто. Группа — до " +
          GROUP_LIMIT +
          " учеников на одном занятии: время общее, оплата у каждого своя.",
    inlineKeyboard(rows)
  );
}

export async function showGroupCard(
  chatId: number | string,
  messageId: number | null,
  groupId: string
): Promise<void> {
  const g = await getGroup(groupId);
  if (!g) {
    await emit(chatId, messageId, "Группа не найдена.");
    return;
  }
  const members = (await listGroupMembers(g.id)).filter((m) => m.active);
  const next = await nextOccurrenceForContact(g.contactKey).catch(() => null);

  const lines = [
    `👥 <b>${escapeHtml(g.name)}</b>`,
    `📚 ${escapeHtml(g.subject)}`,
    `💰 ${g.rateKopecks > 0 ? `${rub(g.rateKopecks)} ₽ за занятие с каждого` : "цена не задана"}`,
    `🧑‍🎓 Участники: ${members.length} из ${GROUP_LIMIT}${
      members.length ? ` — ${escapeHtml(members.map((m) => m.name).join(", "))}` : ""
    }`,
    next ? `🕒 Ближайшее занятие: ${escapeHtml(formatMsk(next))}` : "🕒 Время занятий не задано",
  ];
  if (g.meetLink) lines.push(`🎥 ${escapeHtml(g.meetLink)}`);

  const rows: TgButton[][] = [
    [
      { text: "🧑‍🎓 Участники", data: `grpmem:${g.id}` },
      { text: "🕒 Время занятий", data: `grptime:${g.id}` },
    ],
    [
      { text: "🎥 Телемост", data: `grpmeet:${g.id}` },
      { text: "💰 Цена", data: `grprate:${g.id}` },
    ],
    [{ text: "🗑 Удалить группу", data: `grpdel:${g.id}` }],
    [{ text: "⬅️ Группы", data: "grps" }],
  ];
  await emit(chatId, messageId, lines.join("\n"), inlineKeyboard(rows));
}

// Участники: ссылка на кабинет у каждого своя (личная, как у обычного ученика) —
// её и раздаём. Убрать из группы можно одной кнопкой.
export async function showGroupMembers(
  chatId: number | string,
  messageId: number | null,
  groupId: string
): Promise<void> {
  const g = await getGroup(groupId);
  if (!g) {
    await emit(chatId, messageId, "Группа не найдена.");
    return;
  }
  const members = (await listGroupMembers(g.id)).filter((m) => m.active);
  const base = process.env.SITE_BASE_URL || "";
  const lines = [`🧑‍🎓 <b>Участники — ${escapeHtml(g.name)}</b>`];
  for (const m of members) {
    let link = "";
    try {
      const code = await getOrCreateStudentLinkCode(m.id, false);
      link = base ? `\n   <code>${escapeHtml(`${base}/z/${code}`)}</code>` : "";
    } catch (e) {
      console.error("group member link failed", m.id, e);
    }
    lines.push(`• ${escapeHtml(m.name)}${link}`);
  }
  if (!members.length) lines.push("\nПока никого. Добавьте учеников кнопкой ниже.");

  const rows: TgButton[][] = [];
  if (members.length < GROUP_LIMIT) rows.push([{ text: "➕ Добавить ученика", data: `grpadd:${g.id}` }]);
  for (const m of members) {
    rows.push([{ text: `➖ Убрать ${m.name}`, data: `grpkick:${m.id}:${g.id}` }]);
  }
  rows.push([{ text: "⬅️ Группа", data: `grp:${g.id}` }]);
  await emit(chatId, messageId, lines.join("\n"), inlineKeyboard(rows));
}

// Кого можно добавить: действующие ученики, ещё не состоящие в группе. Пробных не
// предлагаем — сперва пробное занятие, потом решение о группе.
export async function showAddMember(
  chatId: number | string,
  messageId: number | null,
  groupId: string
): Promise<void> {
  const all = await listStudents();
  const free = all.filter((s) => s.active && !s.trial && !s.groupId);
  const rows: TgButton[][] = free.map((s) => [
    { text: `${s.name} · ${s.subject}`, data: `grpjoin:${groupId}:${s.id}` },
  ]);
  rows.push([{ text: "⬅️ Участники", data: `grpmem:${groupId}` }]);
  await emit(
    chatId,
    messageId,
    free.length
      ? "Кого добавить в группу?\n\nБудущие личные занятия ученика при этом снимутся: в группе он занимается по её расписанию."
      : "Свободных учеников нет: все либо уже в группе, либо пробные. Заведите ученика в разделе «Ученики».",
    inlineKeyboard(rows)
  );
}

export async function joinGroup(
  chatId: number | string,
  messageId: number | null,
  groupId: string,
  studentId: string
): Promise<string> {
  const res = await addToGroup(studentId, groupId);
  await showGroupMembers(chatId, messageId, groupId);
  if (!res.ok) {
    return res.reason === "full"
      ? `В группе уже ${GROUP_LIMIT} человек`
      : res.reason === "other-group"
        ? "Ученик уже в другой группе"
        : "Не удалось добавить";
  }
  return res.removedPersonal > 0
    ? `Добавлен · личных занятий снято: ${res.removedPersonal}`
    : "Добавлен в группу";
}

export async function kickFromGroup(
  chatId: number | string,
  messageId: number | null,
  studentId: string,
  groupId: string
): Promise<void> {
  await removeFromGroup(studentId);
  await showGroupMembers(chatId, messageId, groupId);
}

// ── Время занятий ────────────────────────────────────────────────────────────
// Свободные часы считаем той же сеткой, что видит ученик на сайте: занятость по
// AVAILABILITY_WEEKS неделям вперёд, ведь серия займёт время надолго.
export async function showGroupDayPicker(
  chatId: number | string,
  messageId: number | null,
  groupId: string
): Promise<void> {
  const g = await getGroup(groupId);
  if (!g) {
    await emit(chatId, messageId, "Группа не найдена.");
    return;
  }
  const now = new Date();
  const { timeMin, timeMax } = weekWindowBounds(now);
  const busy = await fetchBusy(timeMin, timeMax);
  const days = buildWeek(busy, now).filter((d) => !d.closed && d.slots.some((s) => !s.busy));

  const rows: TgButton[][] = [];
  for (let i = 0; i < days.length; i += 2) {
    rows.push(
      days.slice(i, i + 2).map((d) => ({
        text: `${d.weekday} · свободно ${d.slots.filter((s) => !s.busy).length}`,
        data: `grpday:${groupId}:${d.date}`,
      }))
    );
  }
  rows.push([{ text: "⬅️ Группа", data: `grp:${groupId}` }]);
  await emit(
    chatId,
    messageId,
    `🕒 <b>Время занятий — ${escapeHtml(g.name)}</b>\n\nВыберите день недели. Занятия встанут еженедельно на ${RECURRENCE_WEEKS} недель вперёд.`,
    inlineKeyboard(rows)
  );
}

export async function showGroupTimePicker(
  chatId: number | string,
  messageId: number | null,
  groupId: string,
  dayKey: string
): Promise<void> {
  const now = new Date();
  const { timeMin, timeMax } = weekWindowBounds(now);
  const busy = await fetchBusy(timeMin, timeMax);
  const day = buildWeek(busy, now).find((d) => d.date === dayKey);
  const free = (day?.slots || []).filter((s) => !s.busy);
  if (!free.length) {
    await emit(chatId, messageId, "В этот день свободных часов нет.");
    return;
  }
  // Сами моменты кладём в состояние: в callback_data ISO-время вместе с id группы
  // не влезает (лимит 64 байта), а пересчитывать сетку заново к моменту нажатия
  // нельзя — она зависит от «сейчас» и может сдвинуться.
  await setState(
    String(chatId),
    "grp.time",
    JSON.stringify({ g: groupId, slots: free.map((s) => s.start) })
  );
  const rows: TgButton[][] = [];
  for (let i = 0; i < free.length; i += 3) {
    rows.push(free.slice(i, i + 3).map((s, j) => ({ text: s.time, data: `grpslot:${i + j}` })));
  }
  rows.push([{ text: "⬅️ Дни", data: `grptime:${groupId}` }]);
  await emit(
    chatId,
    messageId,
    `Свободные часы (${escapeHtml(day?.title || "")}). Выберите начало занятия:`,
    inlineKeyboard(rows)
  );
}

// Ставит серию группы на выбранный час. Прежние будущие занятия группы снимаются:
// это и есть «перенести группу на другое время» — двух расписаний у группы не бывает.
export async function setGroupTime(
  chatId: number | string,
  messageId: number | null,
  index: number
): Promise<string> {
  const st = await getState(String(chatId));
  if (!st || st.action !== "grp.time") return "Выбор устарел, начните заново";
  let parsed: { g: string; slots: string[] };
  try {
    parsed = JSON.parse(st.targetId);
  } catch {
    return "Выбор устарел, начните заново";
  }
  const startIso = parsed.slots[index];
  const g = await getGroup(parsed.g);
  if (!startIso || !g) return "Выбор устарел, начните заново";
  await clearState(String(chatId));

  const now = new Date();
  const { timeMin, timeMax } = weekWindowBounds(now);
  const busy = await fetchBusy(timeMin, new Date(timeMax.getTime() + RECURRENCE_WEEKS * 7 * 86400000));
  const plan = buildRecurrence(startIso, RECURRENCE_WEEKS, busy, now, 1);
  if (!plan.ok) {
    await showGroupCard(chatId, messageId, g.id);
    return plan.reason || "Это время уже занято";
  }

  let removed = 0;
  try {
    removed = await deleteFutureEventsForContact(g.contactKey);
  } catch (e) {
    console.error("setGroupTime: не удалось убрать прежние занятия", g.id, e);
  }

  const end = new Date(new Date(startIso).getTime() + 3600000);
  await calendarClient().events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: `${g.name} — ${g.subject}`,
      description: lessonDescription({
        student: g.name,
        subject: g.subject,
        recurring: true,
        confirmed: true,
        meetLink: g.meetLink,
      }),
      start: { dateTime: startIso, timeZone: TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      // Занятие ставит сам преподаватель — подтверждать нечего.
      status: "confirmed",
      ...(plan.recurrence ? { recurrence: plan.recurrence } : {}),
      extendedProperties: {
        private: {
          app: "zapis",
          status: "confirmed",
          contactKey: g.contactKey,
          groupId: g.id,
          student: g.name,
          subject: g.subject,
          weeks: String(RECURRENCE_WEEKS),
          lessons: "1",
        },
      },
    },
  });

  await showGroupCard(chatId, messageId, g.id);
  return removed > 0
    ? `Время задано · прежних занятий снято: ${removed}`
    : `Занятия по ${formatMsk(startIso)}`;
}

// ── Мастер создания и правки полей ───────────────────────────────────────────
export async function promptNewGroup(chatId: number | string): Promise<void> {
  await setState(String(chatId), "grp.new.name", "");
  await sendOwner(
    "👥 <b>Новая группа</b>\n\nПришлите название — его увидят ученики в кабинете. Например: <code>ОГЭ, суббота</code>",
    inlineKeyboard([[{ text: "✖️ Отмена", data: "cancel" }]])
  );
}

export async function submitGroupName(chatId: number | string, name: string): Promise<void> {
  await setState(String(chatId), "grp.new.subject", JSON.stringify({ name }));
  await sendOwner(
    `Название: <b>${escapeHtml(name)}</b>\n\nВыберите предмет:`,
    inlineKeyboard([
      ...SUBJECTS.map((s, i) => [{ text: s, data: `grpsub:${i}` }]),
      [{ text: "✖️ Отмена", data: "cancel" }],
    ])
  );
}

export async function submitGroupSubject(chatId: number | string, index: number): Promise<void> {
  const st = await getState(String(chatId));
  if (!st || st.action !== "grp.new.subject") return;
  const { name } = JSON.parse(st.targetId) as { name: string };
  const subject = SUBJECTS[index] || SUBJECTS[0];
  await setState(String(chatId), "grp.new.rate", JSON.stringify({ name, subject }));
  await sendOwner(
    `Предмет: <b>${escapeHtml(subject)}</b>\n\nПришлите цену ОДНОГО занятия для КАЖДОГО участника, в рублях. Например: <code>750</code>`,
    inlineKeyboard([[{ text: "✖️ Отмена", data: "cancel" }]])
  );
}

export async function submitGroupRate(chatId: number | string, rubles: number): Promise<void> {
  const st = await getState(String(chatId));
  if (!st || st.action !== "grp.new.rate") return;
  const { name, subject } = JSON.parse(st.targetId) as { name: string; subject: string };
  await clearState(String(chatId));
  const g = await createGroup({
    name,
    subject,
    rateKopecks: Math.max(0, Math.round(rubles)) * 100,
  });
  await sendOwner(
    `✅ Группа <b>${escapeHtml(g.name)}</b> создана.\n\nДальше: задайте время занятий и добавьте учеников.`
  );
  await showGroupCard(chatId, null, g.id);
}

export async function promptGroupRate(chatId: number | string, groupId: string): Promise<void> {
  await setState(String(chatId), "grp.rate", groupId);
  await sendOwner(
    "💰 Пришлите цену одного занятия для каждого участника, в рублях:",
    inlineKeyboard([[{ text: "✖️ Отмена", data: "cancel" }]])
  );
}

export async function promptGroupMeet(chatId: number | string, groupId: string): Promise<void> {
  await setState(String(chatId), "grp.meet", groupId);
  await sendOwner(
    "🎥 Пришлите ссылку Яндекс Телемоста для группы — она закрепится в кабинете каждого участника.\nЧтобы убрать ссылку, пришлите <code>-</code>.",
    inlineKeyboard([[{ text: "✖️ Отмена", data: "cancel" }]])
  );
}

// Применяет текстовый ввод к группе. Возвращает true, если ввод был «групповым».
export async function applyGroupInput(
  chatId: number | string,
  action: string,
  targetId: string,
  text: string
): Promise<boolean> {
  if (action === "grp.new.name") {
    await submitGroupName(chatId, text.trim().slice(0, 60));
    return true;
  }
  if (action === "grp.new.rate") {
    await submitGroupRate(chatId, Number(text.replace(/[^\d]/g, "")) || 0);
    return true;
  }
  if (action === "grp.rate") {
    const rub = Math.max(0, Math.round(Number(text.replace(/[^\d]/g, "")) || 0));
    await updateGroup(targetId, { rateKopecks: rub * 100 });
    await clearState(String(chatId));
    await showGroupCard(chatId, null, targetId);
    return true;
  }
  if (action === "grp.meet") {
    await setGroupMeetLink(targetId, text.trim() === "-" ? "" : text.trim());
    await clearState(String(chatId));
    await showGroupCard(chatId, null, targetId);
    return true;
  }
  return false;
}

export async function promptDeleteGroup(
  chatId: number | string,
  messageId: number | null,
  groupId: string
): Promise<void> {
  const g = await getGroup(groupId);
  if (!g) return;
  const members = (await listGroupMembers(g.id)).length;
  await emit(
    chatId,
    messageId,
    `🗑 <b>Удалить группу «${escapeHtml(g.name)}»?</b>\n\nУчеников в группе: ${members} — они станут «без группы», их счета и история останутся. Будущие занятия группы удалятся из Google Calendar, прошедшие останутся как история.`,
    inlineKeyboard([
      [{ text: "🗑 Да, удалить", data: `grpdelyes:${g.id}` }],
      [{ text: "⬅️ Отмена", data: `grp:${g.id}` }],
    ])
  );
}

export async function confirmDeleteGroup(
  chatId: number | string,
  messageId: number | null,
  groupId: string
): Promise<string> {
  const { removed } = await deleteGroup(groupId);
  await showGroupsList(chatId, messageId);
  return removed > 0 ? `Группа удалена · занятий снято: ${removed}` : "Группа удалена";
}
