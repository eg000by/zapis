"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { groupConsecutive } from "@/lib/blocks";
import {
  CALENDAR_MONTHS,
  MSK_OFFSET_MINUTES,
  SLOT_MINUTES,
  SLOT_STEP_MINUTES,
  dayWindow,
} from "@/lib/config";
import ContactFooter from "./ContactFooter";

interface Slot {
  start: string;
  time: string;
  busy: boolean;
}
interface Day {
  date: string;
  closed?: boolean; // выходной: день виден в сетке, но записи нет
  title: string;
  weekday: string;
  slots: Slot[];
}
interface MyEvent {
  id: string;
  student: string;
  subject: string;
  status: string;
  start: string;
  recurring: boolean;
  lessons: number;
  moved: boolean; // разовый перенос одного занятия серии
  origStart: string; // исходное время до переноса (для moved)
}

interface MyPayment {
  id: string;
  amountKopecks: number;
  note: string;
  payLink: string;
  kind: string; // manual | debt | advance
}

// Оплаченный счёт — история оплат в кабинете.
interface PaidRow {
  id: string;
  amountKopecks: number;
  note: string;
  paidAt: string | null;
}

// Баланс оплат: долг / оплачено вперёд (до даты) / остаток. null — ставка не задана.
interface MyBalance {
  debtKopecks: number;
  debtHours: number;
  aheadHours: number;
  paidUntil: string | null;
  balanceKopecks: number;
  rateKopecks: number;
  nextPaid: boolean; // ближайшее занятие уже закрыто балансом
}

// Оплата вперёд одним платежом — второй вариант оплаты ТОГО ЖЕ счёта: пакет
// со скидкой у ОГЭ/ЕГЭ (exam) либо занятия месяца по ставке у остальных.
interface PackageOffer {
  exam: boolean;
  label: string;
  lessons: number;
  amountKopecks: number;
  perLessonKopecks: number;
  savingsKopecks: number;
  savingsPercent: number;
  payLink: string;
}

// "4 500 ₽" из копеек.
function fmtRub(kopecks: number): string {
  return `${(kopecks / 100).toLocaleString("ru-RU")} ₽`;
}

// "занятие/занятия/занятий" по числу.
function lessonsWord(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return "занятие";
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return "занятия";
  return "занятий";
}

// "счёт/счёта/счетов" по числу.
function invoicesWord(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return "счёт";
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return "счёта";
  return "счетов";
}

// "13:00" в МСК из ISO-момента.
function hmMsk(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

// "Понедельник, 14:40 (МСК)" — обезличенный слот недели (для повторяющихся записей:
// каждая неделя повторяется, поэтому показываем день недели + время, без конкретной даты).
function fmtSlotMsk(iso: string, lessons = 1): string {
  const wd = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "long",
  }).format(new Date(iso));
  const day = wd.charAt(0).toUpperCase() + wd.slice(1);
  const start = hmMsk(iso);
  if (lessons <= 1) return `${day}, ${start} (МСК)`;
  const spanMin = (lessons - 1) * SLOT_STEP_MINUTES + SLOT_MINUTES;
  const end = new Date(new Date(iso).getTime() + spanMin * 60000);
  return `${day}, ${start}–${hmMsk(end.toISOString())} (МСК)`;
}

// Первая буква заглавная: Intl отдаёт день недели строчным («вт, 14 июля»).
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// "Ср, 8 июля, 10:00 (МСК)" или, для блока, "…, 10:00–12:10 (МСК)".
function fmtMsk(iso: string, lessons = 1): string {
  const s = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
  if (lessons <= 1) return `${cap(s)} (МСК)`;
  const spanMin = (lessons - 1) * SLOT_STEP_MINUTES + SLOT_MINUTES;
  const end = new Date(new Date(iso).getTime() + spanMin * 60000);
  return `${cap(s)}–${hmMsk(end.toISOString())} (МСК)`;
}

// "Ср, 8 июля" — короткая дата без времени (для списка дат разового переноса).
function fmtDateMsk(iso: string): string {
  return cap(
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      weekday: "short",
      day: "numeric",
      month: "long",
    }).format(new Date(iso))
  );
}

// "8 июля" — дата без дня недели (для заголовка дня в сетке).
function dayMonthMsk(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

// "08.07" — дата для чипа дня недели. Название месяца («8 июл») в ячейку не влезает:
// на телефоне 360 px под чип остаётся ~42 px на все семь дней недели.
function chipDateMsk(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(iso));
}

// ── Календарь «другая дата» ───────────────────────────────────────────────────
// Всё считаем в «стеночных» полях МСК: сервис живёт в одном часовом поясе, и
// сравнивать даты по локальному времени браузера нельзя — ученик может сидеть
// во Владивостоке, где «сегодня» наступает на 7 часов раньше.
const MONTHS_NOM = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];
const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const WD_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

interface MskDate {
  y: number;
  m: number; // 0-11
  d: number;
  wd: number; // 0 = понедельник
}

// «Стеночная» дата МСК для момента.
function mskDateOf(t: Date): MskDate {
  const s = new Date(t.getTime() + MSK_OFFSET_MINUTES * 60000);
  return {
    y: s.getUTCFullYear(),
    m: s.getUTCMonth(),
    d: s.getUTCDate(),
    wd: (s.getUTCDay() + 6) % 7,
  };
}

// Момент 12:00 МСК указанного дня — им и обозначаем выбранную дату: полдень не
// съезжает на соседние сутки ни при каких пересчётах.
function mskNoonIso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m, d, 12) - MSK_OFFSET_MINUTES * 60000).toISOString();
}

// Порядковый номер дня (для сравнения дат без времени).
const dayNo = (x: { y: number; m: number; d: number }) => Date.UTC(x.y, x.m, x.d) / 86400000;

// Понедельник недели, в которую попадает дата.
const mondayNo = (x: MskDate) => dayNo(x) - x.wd;

// «24–30 августа» / «31 августа – 6 сентября» — календарная неделя выбранной даты.
// Считается от самой даты, а не от сетки: сетка по умолчанию — это ближайшие семь
// дней по дням недели, и они могут лежать в двух разных календарных неделях.
function weekRangeLabel(iso: string): string {
  const mon0 = mondayNo(mskDateOf(new Date(iso)));
  const mon = new Date(mon0 * 86400000);
  const sun = new Date((mon0 + 6) * 86400000);
  const d1 = mon.getUTCDate();
  const d2 = sun.getUTCDate();
  const m1 = MONTHS_GEN[mon.getUTCMonth()];
  const m2 = MONTHS_GEN[sun.getUTCMonth()];
  return m1 === m2 ? `${d1}–${d2} ${m1}` : `${d1} ${m1} – ${d2} ${m2}`;
}

export default function BookingClient({
  token,
  greetName,
  subject,
  trial,
}: {
  token: string;
  greetName: string;
  subject: string;
  trial: boolean;
}) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState(0);

  // Выбранные слоты (ISO начала), в порядке выбора.
  const [selected, setSelected] = useState<string[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [doneWhen, setDoneWhen] = useState<string | null>(null);

  // Мои записи.
  const [my, setMy] = useState<MyEvent[] | null>(null);
  const [payments, setPayments] = useState<MyPayment[]>([]);
  // Режим «СБП-перевод»: текст реквизитов вместо кнопки оплаты (пусто при ЮKassa).
  const [payHint, setPayHint] = useState<string>("");
  const [balance, setBalance] = useState<MyBalance | null>(null);
  const [packageOffer, setPackageOffer] = useState<PackageOffer | null>(null);
  const [paidHistory, setPaidHistory] = useState<PaidRow[]>([]);
  // Цена одного занятия — показывается в подтверждении записи (0 — пробное/не задана).
  const [lessonPrice, setLessonPrice] = useState(0);
  // Постоянная ссылка на онлайн-занятие (Яндекс Телемост) — задаёт преподаватель.
  const [meetLink, setMeetLink] = useState<string>("");
  // Подключение уведомлений в Telegram: deep-link на бота + подключено ли уже.
  const [tgNotify, setTgNotify] = useState<{ url: string; connected: boolean } | null>(null);
  // Ближайшее занятие (конкретная дата) — считает сервер с учётом отмен/переносов.
  const [nextLesson, setNextLesson] = useState<string | null>(null);
  // Перенос/отмена: выбранная запись + действие (move/cancel) + режим (all — вся серия,
  // once — одно занятие) + дата занятия.
  const [rsEvent, setRsEvent] = useState<MyEvent | null>(null);
  const [rsKind, setRsKind] = useState<"move" | "cancel" | null>(null);
  const [rsMode, setRsMode] = useState<"all" | "once" | null>(null);
  const [rsOcc, setRsOcc] = useState<string | null>(null);
  // Реальные ближайшие даты серии (из календаря) для выбора одного занятия;
  // null — идёт загрузка.
  const [rsDates, setRsDates] = useState<string[] | null>(null);
  // Ученик с записями открыл сетку, чтобы записаться на дополнительное время.
  const [pickingNew, setPickingNew] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Подряд идущие часы показываем одним блоком («10:00–13:00»).
  const blocks = useMemo(() => groupConsecutive(selected), [selected]);

  const hasBookings = !!(my && my.length > 0);
  // Есть ли подтверждённые занятия. Пока нет — в кабинете не показываем ничего
  // «занятийного» (Телемост, баланс, счета, пакет, ближайшее занятие): только сетку
  // записи и плашку про МСК. Заявки в статусе «ждёт подтверждения» сюда не считаются.
  const hasConfirmedLessons = !!(my && my.some((e) => e.status === "confirmed"));
  // Сетка выбирает новое время переноса, когда выбраны запись, режим move и режим (и дата — для once).
  const rescheduling =
    !!rsEvent && rsKind === "move" && (rsMode === "all" || (rsMode === "once" && !!rsOcc));
  // Промежуточный экран (выбор «одно занятие / вся серия» и даты) — для переноса и отмены.
  const rsChoosing = !!rsEvent && !rescheduling;
  // Сетку слотов показываем: когда записей ТОЧНО нет (my загружен и пуст), либо при
  // переносе, либо когда ученик явно захотел записаться ещё. Пока my === null (идёт
  // загрузка) сетку не показываем — иначе у ученика с записями мелькает «25-й кадр»
  // с расписанием, которое тут же сменяется его кабинетом.
  const myLoading = my === null;
  const showGrid = (!myLoading && !hasBookings) || rescheduling || pickingNew;

  // Деньги — одним блоком: сколько платить сейчас и из чего это состоит.
  // Долгом считаем счета за уже проведённые занятия и ручные (kind ≠ advance),
  // предоплатой — счета «вперёд». Пакет в сумму не входит: это ВТОРОЙ способ
  // оплатить тот же счёт, а не ещё один платёж.
  const dueTotal = payments.reduce((s, p) => s + p.amountKopecks, 0);
  const dueDebt = payments
    .filter((p) => p.kind !== "advance")
    .reduce((s, p) => s + p.amountKopecks, 0);
  const dueAhead = dueTotal - dueDebt;
  const showPayCard =
    hasConfirmedLessons && (dueTotal > 0 || paidHistory.length > 0 || (balance?.aheadHours ?? 0) > 0);

  // Если в окне подтверждения убрали все слоты — закрываем окно.
  useEffect(() => {
    if (sheetOpen && selected.length === 0) setSheetOpen(false);
  }, [sheetOpen, selected]);

  // Панель переноса/отмены и сетка выбора нового времени появляются ниже по странице —
  // на телефоне за пределами экрана. Подводим к ним взгляд сами: иначе после нажатия
  // «Перенести» кажется, что кнопка не сработала.
  const rsPanelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rsChoosing) rsPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [rsChoosing, rsMode, rsOcc]);
  useEffect(() => {
    if (rescheduling || pickingNew) {
      gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [rescheduling, pickingNew]);

  // Какую сетку просить у сервера. Занятие, которое занимает время лишь однажды
  // (пробное; разовый перенос одного занятия серии), не должно упираться в чужие
  // занятия следующих недель — иначе свободный час выглядит занятым.
  // Для разового переноса сервер ещё и сдвигает слоты в неделю переносимого
  // занятия, поэтому в чипах дней стоят настоящие даты, а start слота — то самое
  // время, которое уйдёт в запрос переноса.
  const gridOcc = rsKind === "move" && rsMode === "once" && rsOcc ? rsOcc : null;
  // Ручная перезагрузка сетки — через счётчик, а не прямым вызовом (см. эффект ниже).
  const [slotsNonce, setSlotsNonce] = useState(0);
  const reloadSlots = () => setSlotsNonce((n) => n + 1);
  // Выбранная в календаре дата: сетка показывает её календарную неделю. null —
  // ближайшая неделя (обычный режим). Перекрывает и неделю разового переноса:
  // если ученик открыл календарь во время переноса, он хочет именно другую неделю.
  const [weekFrom, setWeekFrom] = useState<string | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const slotsUrl = (() => {
    const q: string[] = [];
    if (trial) q.push("trial=1");
    if (gridOcc) q.push(`occ=${encodeURIComponent(gridOcc)}`);
    if (weekFrom) q.push(`from=${encodeURIComponent(weekFrom)}`);
    return q.length ? `/api/slots?${q.join("&")}` : "/api/slots";
  })();

  function loadSlots() {
    setDays(null);
    fetch(slotsUrl)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setLoadError(d.error);
        else {
          setDays(d.days || []);
          setActiveDay((a) => Math.min(a, Math.max(0, (d.days || []).length - 1)));
        }
      })
      .catch(() => setLoadError("Не удалось загрузить расписание. Попробуйте позже."));
  }

  function loadMy() {
    fetch(`/api/my?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => {
        setMy(d.events || []);
        setPayments(d.payments || []);
        setPayHint(d.payHint || "");
        setBalance(d.balance || null);
        setPackageOffer(d.packageOffer || null);
        setPaidHistory(d.paidHistory || []);
        setLessonPrice(d.lessonPriceKopecks || 0);
        setMeetLink(d.meetLink || "");
        setTgNotify(d.tgNotify || null);
        setNextLesson(d.nextLesson || null);
      })
      .catch(() => setMy([]));
  }

  // Тихо обновляет сетку (без спиннера). Если prune — убирает из выбора слоты,
  // которые только что заняли. Возвращает оставшиеся выбранные слоты.
  async function refreshSlots(prune = false): Promise<string[]> {
    try {
      const d = await fetch(slotsUrl).then((r) => r.json());
      if (d.error) return selected;
      const nd: Day[] = d.days || [];
      setDays(nd);
      setActiveDay((a) => Math.min(a, Math.max(0, nd.length - 1)));
      if (!prune) return selected;
      const free = new Set<string>();
      nd.forEach((dd) => dd.slots.forEach((s) => !s.busy && free.add(s.start)));
      const survivors = selected.filter((st) => free.has(st));
      setSelected(survivors);
      return survivors;
    } catch {
      return selected;
    }
  }

  useEffect(() => {
    loadMy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Сетка перезагружается ровно из одного места: при первом открытии, при смене
  // недели разового переноса и по reloadSlots() после успешных записи/отмены/
  // переноса. Иначе два запроса (смена gridOcc и ручной вызов) гонялись бы за
  // право показать свой результат — и на экране могла остаться чужая неделя.
  useEffect(() => {
    loadSlots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOcc, weekFrom, slotsNonce]);

  // ── Календарь «другая дата» ────────────────────────────────────────────────
  // Месяц, открытый в календаре: 0 — текущий, дальше листается до CALENDAR_MONTHS.
  const [calMonth, setCalMonth] = useState(0);

  const calCells = useMemo(() => {
    const today = mskDateOf(new Date());
    const y = new Date(Date.UTC(today.y, today.m + calMonth, 1)).getUTCFullYear();
    const m = new Date(Date.UTC(today.y, today.m + calMonth, 1)).getUTCMonth();
    const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // пустые клетки до 1-го
    const total = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const pickedNo = weekFrom ? dayNo(mskDateOf(new Date(weekFrom))) : null;

    const cells: {
      key: string;
      d: number | null;
      y: number;
      m: number;
      disabled: boolean;
      isToday: boolean;
      picked: boolean;
    }[] = [];
    for (let i = 0; i < lead; i++) {
      cells.push({ key: `x${i}`, d: null, y, m, disabled: true, isToday: false, picked: false });
    }
    for (let d = 1; d <= total; d++) {
      const no = dayNo({ y, m, d });
      // dayWindow работает в номерах JS (0 = воскресенье), сетка календаря — с
      // понедельника, поэтому день недели берём в «сыром» виде.
      const closed = !dayWindow(new Date(Date.UTC(y, m, d)).getUTCDay());
      cells.push({
        key: `${m}-${d}`,
        d,
        y,
        m,
        disabled: no < dayNo(today) || closed,
        isToday: no === dayNo(today),
        picked: pickedNo === no,
      });
    }
    return { y, m, cells };
  }, [calMonth, weekFrom]);

  // Выбор даты в календаре: сетка переезжает на её календарную неделю, а активным
  // становится сам выбранный день. Дату текущей недели в weekFrom не пишем —
  // обычная сетка и так показывает ближайшие дни (и корректно прячет прошедшие).
  function pickDate(y: number, m: number, d: number) {
    const iso = mskNoonIso(y, m, d);
    const picked = mskDateOf(new Date(iso));
    const today = mskDateOf(new Date());
    setWeekFrom(mondayNo(picked) === mondayNo(today) ? null : iso);
    setActiveDay(picked.wd);
    setCalOpen(false);
  }

  function toggleSlot(start: string) {
    // Пробное занятие одно — выбор одиночный (новый клик заменяет прежний слот).
    if (trial) {
      setSelected((cur) => (cur.includes(start) ? [] : [start]));
      return;
    }
    setSelected((cur) =>
      cur.includes(start) ? cur.filter((s) => s !== start) : [...cur, start]
    );
  }

  function removeSlots(slots: string[]) {
    setSelected((cur) => cur.filter((s) => !slots.includes(s)));
  }

  // Сбрасывает состояние переноса/отмены (не трогая notice — чтобы не стирать сообщение
  // об успехе). cancelReschedule дополнительно чистит notice — для явного «Закрыть».
  function resetRs() {
    setRsEvent(null);
    setRsKind(null);
    setRsMode(null);
    setRsOcc(null);
    setRsDates(null);
  }

  // Загружает реальные ближайшие даты серии (учитывает отменённые/перенесённые недели).
  async function loadOccurrences(ev: MyEvent) {
    setRsDates(null);
    try {
      const d = await fetch(
        `/api/occurrences?token=${encodeURIComponent(token)}&eventId=${encodeURIComponent(ev.id)}`
      ).then((r) => r.json());
      setRsDates(d.occurrences || []);
    } catch {
      setRsDates([]);
    }
  }
  function cancelReschedule() {
    resetRs();
    setNotice(null);
  }

  // Начать перенос записи. Для повторяющейся серии сперва спросим режим (разово/еженедельно);
  // для разового занятия или уже перенесённого — сразу к выбору нового времени.
  function startReschedule(ev: MyEvent) {
    setRsEvent(ev);
    setRsKind("move");
    setSelected([]);
    setPickingNew(false);
    if (ev.moved) {
      // Уже перенесённое одиночное занятие — двигаем его же ещё раз.
      setRsMode("once");
      setRsOcc(ev.origStart || ev.start);
      setNotice("Выберите новое время для этого занятия.");
    } else if (!ev.recurring) {
      // Разовое (пробное) занятие — переносим целиком.
      setRsMode("all");
      setRsOcc(null);
      setNotice("Выберите новое время ниже для переноса.");
    } else {
      // Повторяющаяся серия — спросим, что именно переносим.
      setRsMode(null);
      setRsOcc(null);
      setNotice(null);
    }
  }

  async function pickForReschedule(start: string) {
    if (!rsEvent) return;
    setBusyAction(true);
    setNotice(null);
    // Слот сетки уже стоит на нужной дате: для разового переноса сервер построил
    // её на неделю переносимого занятия (см. gridOcc), и досдвигать нечего.
    const target = start;
    try {
      const res = await fetch("/api/reschedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          eventId: rsEvent.id,
          start: target,
          mode: rsMode || "all",
          ...(rsMode === "once" && rsOcc ? { occStart: rsOcc } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Например, слот заняли за секунду до нас — обновляем сетку, старая бронь цела.
        setNotice(data.error || "Не удалось перенести запись. Ваше прежнее время осталось за вами.");
        await refreshSlots(false);
      } else {
        resetRs();
        setNotice(`Перенесено на ${data.when}. Ждём подтверждения преподавателя.`);
        reloadSlots();
        loadMy();
      }
    } catch {
      setNotice("Ошибка сети. Попробуйте ещё раз.");
    } finally {
      setBusyAction(false);
    }
  }

  // Начать отмену. Разовое/перенесённое занятие отменяем сразу (с подтверждением);
  // для повторяющейся серии спросим — одно занятие или всю серию.
  function startCancel(ev: MyEvent) {
    if (ev.moved) {
      if (confirm(`Отменить перенесённое занятие ${fmtMsk(ev.start, ev.lessons)}?`)) {
        doCancel(ev, "once");
      }
      return;
    }
    if (!ev.recurring) {
      if (confirm(`Отменить запись ${fmtMsk(ev.start, ev.lessons)}?`)) doCancel(ev, "all");
      return;
    }
    setRsEvent(ev);
    setRsKind("cancel");
    setRsMode(null);
    setRsOcc(null);
    setSelected([]);
    setPickingNew(false);
    setNotice(null);
  }

  async function doCancel(ev: MyEvent, mode: "all" | "once", occStart?: string) {
    setBusyAction(true);
    setNotice(null);
    try {
      const res = await fetch("/api/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, eventId: ev.id, mode, ...(occStart ? { occStart } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) setNotice(data.error || "Не удалось отменить запись.");
      else {
        resetRs();
        setNotice(mode === "once" ? "Занятие отменено." : "Запись отменена.");
        reloadSlots();
        loadMy();
      }
    } catch {
      setNotice("Ошибка сети. Попробуйте ещё раз.");
    } finally {
      setBusyAction(false);
    }
  }

  // Вернуть разово перенесённое занятие на его исходное (до переноса) время.
  async function returnEvent(ev: MyEvent) {
    const where = ev.origStart ? ` (${fmtMsk(ev.origStart, ev.lessons)})` : "";
    if (!confirm(`Вернуть занятие на прежнее время${where}?`)) return;
    setBusyAction(true);
    setNotice(null);
    try {
      const res = await fetch("/api/return", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, eventId: ev.id }),
      });
      const data = await res.json();
      if (!res.ok) setNotice(data.error || "Не удалось вернуть занятие.");
      else {
        setNotice(`Занятие возвращено на ${data.when}.`);
        reloadSlots();
        loadMy();
      }
    } catch {
      setNotice("Ошибка сети. Попробуйте ещё раз.");
    } finally {
      setBusyAction(false);
    }
  }

  function onSlotClick(s: Slot) {
    if (rescheduling) {
      pickForReschedule(s.start);
      return;
    }
    toggleSlot(s.start);
  }

  async function submit() {
    if (selected.length === 0) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, starts: selected }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Слот могли занять за секунду до нас — обновляем сетку и убираем занятое.
        const survivors = await refreshSlots(true);
        setSubmitting(false);
        if (survivors.length === 0) {
          setSheetOpen(false);
          setNotice("Выбранное время только что заняли. Пожалуйста, выберите другое.");
        } else {
          setFormError(data.error || "Это время уже заняли. Сетка обновлена — выберите другое.");
        }
        return;
      }
      setDoneWhen(data.when || null);
      setSheetOpen(false);
      setSelected([]);
      setPickingNew(false);
      setSubmitting(false);
      // Запись создана — следующий заход начинаем с ближайшей недели, а не с той,
      // куда ученик уходил календарём.
      setWeekFrom(null);
      reloadSlots();
      loadMy();
    } catch {
      setFormError("Ошибка сети. Попробуйте ещё раз.");
      setSubmitting(false);
    }
  }

  // Панель выбора «одно занятие / вся серия» (и дат для одного занятия). Рендерится
  // ВНУТРИ карточки записей, прямо под той записью, которую переносим/отменяем —
  // раньше она уезжала под все карточки и на телефоне была за пределами экрана.
  const rsPanel =
    rsChoosing && rsEvent ? (
      <div className="reschedule-bar column" ref={rsPanelRef}>
        <span>
          {rsKind === "cancel" ? "Отменяем" : "Переносим"}:{" "}
          <b>{fmtSlotMsk(rsEvent.start, rsEvent.lessons)}</b>
        </span>

        {rsMode === null && (
          <div className="choice-row">
            <button
              className="mini"
              onClick={() => {
                setRsMode("once");
                loadOccurrences(rsEvent);
              }}
            >
              📅 Только одно занятие
            </button>
            {rsKind === "cancel" ? (
              <button
                className="mini danger"
                onClick={() => {
                  if (confirm(`Отменить все занятия ${fmtSlotMsk(rsEvent.start, rsEvent.lessons)}?`)) {
                    doCancel(rsEvent, "all");
                  }
                }}
              >
                🗑 Всю серию
              </button>
            ) : (
              <button className="mini" onClick={() => { setRsMode("all"); setRsOcc(null); }}>
                🔁 Каждую неделю
              </button>
            )}
            <button className="mini" onClick={cancelReschedule}>
              Закрыть
            </button>
          </div>
        )}

        {rsMode === "once" && !rsOcc && (
          <>
            <span className="my-when">
              {rsDates === null
                ? "Загрузка занятий…"
                : rsDates.length === 0
                  ? "Нет ближайших занятий."
                  : `Какое занятие ${rsKind === "cancel" ? "отменяем" : "переносим"}?`}
            </span>
            <div className="choice-row">
              {(rsDates || []).map((iso) => (
                <button
                  key={iso}
                  className={`mini${rsKind === "cancel" ? " danger" : ""}`}
                  onClick={() => {
                    if (rsKind === "cancel") {
                      if (confirm(`Отменить занятие ${fmtDateMsk(iso)}?`)) doCancel(rsEvent, "once", iso);
                    } else {
                      setRsOcc(iso);
                      setNotice("Выберите новое время ниже для переноса.");
                    }
                  }}
                >
                  {fmtDateMsk(iso)}
                </button>
              ))}
              <button className="mini" onClick={cancelReschedule}>
                Закрыть
              </button>
            </div>
          </>
        )}
      </div>
    ) : null;

  // Экран успеха
  if (doneWhen) {
    return (
      <div className="wrap">
        <div className="success">
          <div className="emoji">🎉</div>
          <h2>Заявка отправлена!</h2>
          <p style={{ whiteSpace: "pre-line" }}>
            Вы выбрали:{"\n"}
            <b>{doneWhen}</b>
            {"\n\n"}Преподаватель подтвердит запись, и время закрепится за вами. Спасибо!
          </p>
          <button className="btn" style={{ maxWidth: 260, margin: "24px auto 0" }} onClick={() => setDoneWhen(null)}>
            Готово
          </button>
        </div>
        <ContactFooter />
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="hero">
        <h1>Здравствуйте, {greetName}! 👋</h1>
        {/* Подзаголовок меняется по режиму экрана: пока выбираем время — приглашение
            к записи; когда записи уже есть и показан кабинет — что здесь лежит. */}
        <p>
          {myLoading ? (
            "Загружаем ваши записи…"
          ) : showGrid ? (
            <>
              {trial ? "Выберите время для пробного занятия" : "Выберите удобное время для занятий"}{" "}
              по предмету «<b>{subject}</b>».
            </>
          ) : (
            <>
              Ваши занятия и оплата по предмету «<b>{subject}</b>».
            </>
          )}
        </p>
        {showGrid && <span className="tz-badge">🕒 Время указано по Москве (МСК)</span>}
      </div>

      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {/* Пока не знаем, есть ли записи, — спиннер вместо сетки (без «25-го кадра»). */}
      {myLoading && <div className="spinner" />}

      {hasConfirmedLessons && nextLesson && (
        <div className="next-lesson">
          📌 Ближайшее занятие: <b>{fmtMsk(nextLesson)}</b>
          {/* Оплата вперёд должна быть видна там, где ученик смотрит на само занятие,
              а не только в блоке денег. */}
          {balance?.nextPaid && <span className="badge ok">✅ оплачено</span>}
        </div>
      )}

      {hasConfirmedLessons && meetLink && (
        <a className="next-lesson meet-link" href={meetLink} target="_blank" rel="noreferrer">
          🎥 Подключиться к занятию (Яндекс Телемост) ↗
        </a>
      )}

      {/* Уведомления в Telegram. Бот не может написать первым — ученик подключается
          сам по deep-link, и /start привязывает его чат. Подключённому кнопку не
          показываем: нажимать больше нечего. */}
      {hasConfirmedLessons && tgNotify && (
        tgNotify.connected ? (
          <div className="next-lesson tg-on">✅ Уведомления в Telegram подключены</div>
        ) : (
          <a className="next-lesson tg-link" href={tgNotify.url} target="_blank" rel="noreferrer">
            <span>
              🔔 <b>Подключить уведомления в Telegram →</b>
              <small>
                Откроется бот — нажмите «Запустить». Напомним о занятии заранее и пришлём
                ссылку на Телемост.
              </small>
            </span>
          </a>
        )
      )}

      {/* Записи — выше денег: расписание для ученика главнее счёта. */}
      {my && my.length > 0 && (
        <div className="card my-card">
          <div className="day-title">Ваши записи</div>
          {my.map((ev) => (
            <div key={ev.id} className="my-item">
              <div className="my-row">
                {/* Имя и предмет не показываем: ученик открыл СВОЙ кабинет по личной
                    ссылке и знает их без нас. Главное в строке — время записи. */}
                <div className="my-info">
                  {ev.moved ? (
                    <>
                      <span className="my-when when-main">{fmtMsk(ev.start, ev.lessons)}</span>
                      {ev.origStart && (
                        <span className="my-when">было: {fmtMsk(ev.origStart, ev.lessons)}</span>
                      )}
                      <span className="badge move">🔄 перенос</span>
                    </>
                  ) : (
                    <span className="my-when when-main">
                      {ev.recurring ? fmtSlotMsk(ev.start, ev.lessons) : fmtMsk(ev.start, ev.lessons)}
                      {ev.recurring ? " · еженедельно" : ""}
                    </span>
                  )}
                  <span className={`badge ${ev.status === "confirmed" ? "ok" : "wait"}`}>
                    {ev.status === "confirmed" ? "✅ подтверждено" : "⏳ ждёт подтверждения"}
                  </span>
                </div>
                <div className="my-actions">
                  <button
                    className="mini"
                    disabled={busyAction || (!!rsEvent && rsEvent.id !== ev.id)}
                    onClick={() => startReschedule(ev)}
                  >
                    Перенести
                  </button>
                  {ev.moved && (
                    <button
                      className="mini"
                      disabled={busyAction || (!!rsEvent && rsEvent.id !== ev.id)}
                      onClick={() => returnEvent(ev)}
                    >
                      Вернуть
                    </button>
                  )}
                  <button
                    className="mini danger"
                    disabled={busyAction || (!!rsEvent && rsEvent.id !== ev.id)}
                    onClick={() => startCancel(ev)}
                  >
                    Отменить
                  </button>
                </div>
              </div>
              {/* Выбор «одно занятие / вся серия» — сразу под своей записью. */}
              {rsEvent?.id === ev.id && rsPanel}
            </div>
          ))}
          {/* Пробное занятие одно — вторую запись не предлагаем. */}
          {!rsEvent && !pickingNew && !trial && (
            <button
              className="mini"
              style={{ marginTop: 12 }}
              disabled={busyAction}
              onClick={() => {
                setPickingNew(true);
                setNotice("Выберите время для новой записи ниже.");
              }}
            >
              ＋ Записаться на другое время
            </button>
          )}
        </div>
      )}

      {/* Деньги — ОДИН блок: сумма к оплате, из чего она состоит, срок и способ.
          Раньше здесь были две карточки («Баланс» и «К оплате») с разными числами,
          и было непонятно, какое из них платить. */}
      {showPayCard && (
        <div className="card my-card pay-card">
          {dueTotal > 0 ? (
            <>
              <div className="day-title">К оплате сейчас</div>
              <div className="pay-total">{fmtRub(dueTotal)}</div>
              <div className="pay-split">
                {dueDebt > 0 && dueAhead > 0
                  ? `из них долг за прошедшие — ${fmtRub(dueDebt)} · вперёд — ${fmtRub(dueAhead)}`
                  : dueDebt > 0
                    ? "долг за уже проведённые занятия"
                    : "предоплата за будущие занятия"}
              </div>
              <div className={`pay-due${dueDebt > 0 ? " overdue" : ""}`}>
                {dueDebt > 0
                  ? "⚠️ Занятия уже проведены — оплатите, пожалуйста, сегодня"
                  : nextLesson
                    ? `📅 Оплатить до ${fmtDateMsk(nextLesson)} — начала следующего занятия`
                    : "📅 Оплатить до следующего занятия"}
              </div>

              {/* Экзаменационному ученику показываем ДВА способа оплатить один и тот же
                  счёт: поштучно и пакетом. Пакет не добавляется к сумме — он её закрывает. */}
              {packageOffer ? (
                <div className="pay-options">
                  <div className="pay-opt">
                    <div className="pay-opt-head">
                      <b>По одному занятию</b>
                      <span className="pay-opt-price">{fmtRub(dueTotal)}</span>
                    </div>
                    <div className="pay-opt-note">
                      {payments.length === 1 && payments[0].note
                        ? payments[0].note
                        : `${payments.length} ${invoicesWord(payments.length)}: долг и ближайшее занятие`}
                    </div>
                    {payments.length === 1 ? (
                      payments[0].payLink ? (
                        <a className="pay-btn" href={payments[0].payLink} target="_blank" rel="noreferrer">
                          Оплатить {fmtRub(dueTotal)} ↗
                        </a>
                      ) : !payHint ? (
                        <span className="badge wait">ждём ссылку на оплату</span>
                      ) : null
                    ) : (
                      <div className="pay-list">
                        {payments.map((p) => (
                          <div key={p.id} className="pay-row">
                            <span>{fmtRub(p.amountKopecks)}</span>
                            {p.payLink ? (
                              <a className="pay-btn small" href={p.payLink} target="_blank" rel="noreferrer">
                                Оплатить ↗
                              </a>
                            ) : !payHint ? (
                              <span className="badge wait">ждём ссылку</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pay-opt best">
                    <div className="pay-opt-head">
                      <b>
                        {packageOffer.exam
                          ? `${packageOffer.lessons} ${lessonsWord(packageOffer.lessons)} сразу`
                          : `Месяц вперёд · ${packageOffer.lessons} ${lessonsWord(packageOffer.lessons)}`}
                      </b>
                      <span className="pay-opt-price">{fmtRub(packageOffer.amountKopecks)}</span>
                      {/* Выгоду показываем, только если она есть: при индивидуальной
                          ставке пакет может не быть дешевле поштучной оплаты. */}
                      {packageOffer.savingsKopecks > 0 && (
                        <span className="pkg-save">
                          −{packageOffer.savingsPercent}% · выгода {fmtRub(packageOffer.savingsKopecks)}
                        </span>
                      )}
                    </div>
                    <div className="pay-opt-note">
                      {packageOffer.exam
                        ? "Пакет закрывает текущий счёт: занятия спишутся с него, платить отдельно не нужно."
                        : "Один платёж закрывает текущий счёт и остальные занятия месяца — платить отдельно не нужно."}
                    </div>
                    {packageOffer.payLink ? (
                      <a
                        className="pay-btn primary"
                        href={packageOffer.payLink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {packageOffer.exam ? "Оплатить пакет" : "Оплатить месяц"}{" "}
                        {fmtRub(packageOffer.amountKopecks)} ↗
                      </a>
                    ) : !payHint ? (
                      <span className="badge wait">ждём ссылку на оплату</span>
                    ) : null}
                  </div>
                </div>
              ) : payments.length === 1 ? (
                payments[0].payLink ? (
                  <a className="pay-btn primary" href={payments[0].payLink} target="_blank" rel="noreferrer">
                    Оплатить {fmtRub(dueTotal)} ↗
                  </a>
                ) : !payHint ? (
                  <span className="badge wait">ждём ссылку на оплату</span>
                ) : null
              ) : (
                <div className="pay-list">
                  {payments.map((p) => (
                    <div key={p.id} className="pay-row">
                      <div className="my-info">
                        <b>{fmtRub(p.amountKopecks)}</b>
                        {p.note && <span className="my-when">{p.note}</span>}
                      </div>
                      {p.payLink ? (
                        <a className="pay-btn small" href={p.payLink} target="_blank" rel="noreferrer">
                          Оплатить ↗
                        </a>
                      ) : !payHint ? (
                        <span className="badge wait">ждём ссылку</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              {payHint && <p className="hint" style={{ marginTop: 12 }}>💳 {payHint}</p>}
            </>
          ) : (
            <>
              <div className="day-title">Оплата</div>
              <div className="pay-ok">
                ✅ {balance?.nextPaid ? "Ближайшее занятие оплачено" : "Всё оплачено"}
              </div>
              <div className="pay-split">
                {balance && balance.aheadHours > 0 && balance.paidUntil
                  ? `Оплачено вперёд: ${balance.aheadHours} ${lessonsWord(balance.aheadHours)}, до ${fmtDateMsk(balance.paidUntil)} включительно · платить сейчас ничего не нужно`
                  : "Платить сейчас ничего не нужно"}
              </div>
              {balance && balance.balanceKopecks > 0 && (
                <div className="pay-split">Остаток на балансе: {fmtRub(balance.balanceKopecks)}</div>
              )}
              {/* Оплатить ещё дальше вперёд — по желанию: счёта нет, поэтому это
                  предложение, а не требование, и подписано именно так. */}
              {packageOffer && (
                <div className="pay-opt ahead">
                  <div className="pay-opt-head">
                    <b>
                      {packageOffer.exam
                        ? `${packageOffer.lessons} ${lessonsWord(packageOffer.lessons)} сразу`
                        : `Оплатить вперёд · ${packageOffer.lessons} ${lessonsWord(packageOffer.lessons)}`}
                    </b>
                    <span className="pay-opt-price">{fmtRub(packageOffer.amountKopecks)}</span>
                    {packageOffer.savingsKopecks > 0 && (
                      <span className="pkg-save">
                        −{packageOffer.savingsPercent}% · выгода {fmtRub(packageOffer.savingsKopecks)}
                      </span>
                    )}
                  </div>
                  <div className="pay-opt-note">
                    По желанию: закрыть следующие занятия одним платежом, чтобы не платить
                    перед каждым.
                  </div>
                  {packageOffer.payLink ? (
                    <a className="pay-btn" href={packageOffer.payLink} target="_blank" rel="noreferrer">
                      Оплатить {fmtRub(packageOffer.amountKopecks)} ↗
                    </a>
                  ) : !payHint ? (
                    <span className="badge wait">ждём ссылку на оплату</span>
                  ) : null}
                </div>
              )}
              {payHint && <p className="hint" style={{ marginTop: 12 }}>💳 {payHint}</p>}
            </>
          )}

          {/* История оплат: «я же платил» ученик проверяет сам. */}
          {paidHistory.length > 0 && (
            <details className="pay-history">
              <summary>Оплачено ранее ({paidHistory.length})</summary>
              {paidHistory.map((h) => (
                <div key={h.id} className="pay-hist-row">
                  <span className="my-when">{h.paidAt ? fmtDateMsk(h.paidAt) : "—"}</span>
                  <b>{fmtRub(h.amountKopecks)}</b>
                  {h.note && <span className="my-when">{h.note}</span>}
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      {/* Активный перенос: сетка ниже выбирает новое время. */}
      {rescheduling && (
        <div className="reschedule-bar">
          <span>
            Переносим {rsMode === "once" && rsOcc ? <b>{fmtDateMsk(rsOcc)}</b> : "серию"}: выберите новое время.
          </span>
          <button className="mini" onClick={cancelReschedule}>
            Отмена
          </button>
        </div>
      )}

      {loadError && showGrid && (
        <div className="center-note">
          <span className="emoji">😕</span>
          <p>{loadError}</p>
        </div>
      )}

      {showGrid && !loadError && days === null && <div className="spinner" />}

      {showGrid && !loadError && days !== null && days.length === 0 && (
        <div className="center-note">
          <span className="emoji">📭</span>
          <p>Свободных слотов на ближайшее время нет. Загляните чуть позже.</p>
        </div>
      )}

      {showGrid && !loadError && days !== null && days.length > 0 && (
        <>
          {/* Какая неделя в сетке + вход в календарь. Одна строка на всю
              «гибкость выбора»: сами чипы дней остаются прежними. */}
          <div className="week-bar">
            <span className="week-label">
              {weekFrom ? <>Неделя <b>{weekRangeLabel(weekFrom)}</b></> : "Ближайшие дни"}
            </span>
            <span className="week-actions">
              {weekFrom && (
                <button className="mini" onClick={() => setWeekFrom(null)}>
                  ← Ближайшие
                </button>
              )}
              <button
                className="mini"
                onClick={() => {
                  setCalMonth(0);
                  setCalOpen(true);
                }}
              >
                📅 Другая дата
              </button>
            </span>
          </div>

          <div className="day-nav" ref={gridRef}>
            {days.map((d, i) => (
              <button
                key={d.date}
                className={`day-chip ${i === activeDay ? "active" : ""} ${d.closed ? "closed" : ""}`}
                onClick={() => setActiveDay(i)}
              >
                <b>{d.weekday}</b>
                {/* Конкретная дата ближайшего наступления: без неё ученик (особенно
                    на разовом пробном) не понимает, на какое число записывается. */}
                {d.slots[0] && <small>{chipDateMsk(d.slots[0].start)}</small>}
              </button>
            ))}
          </div>

          <div className="card">
            <div className="day-title">
              {days[activeDay].title}
              {days[activeDay].slots[0] ? `, ${dayMonthMsk(days[activeDay].slots[0].start)}` : ""}
            </div>
            {days[activeDay].closed ? (
              <p className="hint" style={{ margin: "4px 2px" }}>
                🌙 Выходной — в этот день занятий нет. Выберите другой день недели.
              </p>
            ) : (
              <>
                <div className="slots-grid">
                  {days[activeDay].slots.map((s) =>
                    s.busy ? (
                      <div key={s.start} className="slot busy">
                        {s.time}
                        <small>занято</small>
                      </div>
                    ) : (
                      <button
                        key={s.start}
                        className={`slot ${selected.includes(s.start) ? "picked" : ""}`}
                        disabled={busyAction}
                        onClick={() => onSlotClick(s)}
                      >
                        {s.time}
                      </button>
                    )
                  )}
                </div>
                <p className="hint">
                  {rescheduling
                    ? "Нажмите на свободное время — запись переедет на него."
                    : "Можно выбрать несколько слотов. Серые — уже заняты."}
                </p>
              </>
            )}
          </div>
        </>
      )}

      {/* Выход из режима «записаться ещё» — доступен всегда (и при пустой сетке,
          и при ошибке загрузки), иначе из режима было бы не выбраться. */}
      {pickingNew && !rescheduling && (
        <button
          className="mini"
          style={{ marginTop: 12 }}
          disabled={busyAction}
          onClick={() => {
            setPickingNew(false);
            setSelected([]);
            setNotice(null);
          }}
        >
          Свернуть выбор времени
        </button>
      )}

      <ContactFooter />

      {/* Нижняя панель выбора */}
      {!rescheduling && selected.length > 0 && !sheetOpen && (
        <div className="picker-bar">
          <span>
            Выбрано слотов: <b>{selected.length}</b>
          </span>
          <button className="picker-btn" onClick={() => { setSheetOpen(true); setFormError(null); }}>
            Записаться →
          </button>
        </div>
      )}

      {/* Календарь: выбор даты на CALENDAR_MONTHS месяцев вперёд. Открывается по
          кнопке и не занимает места на экране, пока не нужен. */}
      {calOpen && (
        <div className="overlay" onClick={() => setCalOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="cal-head">
              <button
                className="mini"
                disabled={calMonth === 0}
                onClick={() => setCalMonth((c) => Math.max(0, c - 1))}
                aria-label="Предыдущий месяц"
              >
                ‹
              </button>
              <b>
                {MONTHS_NOM[calCells.m]} {calCells.y}
              </b>
              <button
                className="mini"
                disabled={calMonth >= CALENDAR_MONTHS - 1}
                onClick={() => setCalMonth((c) => Math.min(CALENDAR_MONTHS - 1, c + 1))}
                aria-label="Следующий месяц"
              >
                ›
              </button>
            </div>

            <div className="cal-grid">
              {WD_SHORT.map((w) => (
                <span key={w} className="cal-wd">
                  {w}
                </span>
              ))}
              {calCells.cells.map((c) =>
                c.d === null ? (
                  <span key={c.key} />
                ) : (
                  <button
                    key={c.key}
                    className={`cal-day${c.picked ? " picked" : ""}${c.isToday ? " today" : ""}`}
                    disabled={c.disabled}
                    onClick={() => pickDate(c.y, c.m, c.d!)}
                  >
                    {c.d}
                  </button>
                )
              )}
            </div>

            <p className="sheet-note">
              Выберите день — сетка покажет его неделю. Выходные и прошедшие даты
              недоступны; занятость каждого часа видна уже в сетке.
            </p>
            <button className="btn btn-ghost" onClick={() => setCalOpen(false)}>
              Закрыть
            </button>
          </div>
        </div>
      )}

      {sheetOpen && (
        <div className="overlay" onClick={() => !submitting && setSheetOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Подтверждение записи</h2>
            <p className="when">{subject}</p>

            <div className="summary">
              {/* Конкретная дата, а не «Вторник»: ученик должен видеть, на какое
                  число он записывается (для еженедельной серии — дата первого занятия). */}
              {blocks.map((b) => (
                <div key={b.start} className="summary-row">
                  <div className="summary-when">
                    {fmtMsk(b.start, b.slots.length)}
                    <span className="summary-tag">{trial ? "разово" : "далее еженедельно"}</span>
                  </div>
                  <button
                    className="chip-x"
                    onClick={() => removeSlots(b.slots)}
                    aria-label="Убрать"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {/* Цена — до записи, а не постфактум из счёта. */}
            {trial ? (
              <p className="sheet-price">
                Пробное занятие — <b>бесплатно</b>
              </p>
            ) : lessonPrice > 0 ? (
              <p className="sheet-price">
                {selected.length} {lessonsWord(selected.length)} × {fmtRub(lessonPrice)} ={" "}
                <b>{fmtRub(lessonPrice * selected.length)}</b> в неделю
              </p>
            ) : null}

            <p className="sheet-note">
              {trial
                ? "Разовое пробное занятие. Отменить или перенести можно в разделе «Ваши записи»."
                : "Время закрепится за вами каждую неделю, оплата — после подтверждения. Перенести или отменить можно в разделе «Ваши записи»."}
            </p>

            {formError && <div className="error-text">{formError}</div>}

            <button className="btn" onClick={submit} disabled={submitting || selected.length === 0}>
              {submitting
                ? "Отправляем…"
                : `Записаться${blocks.length > 1 ? ` (${blocks.length})` : ""}`}
            </button>
            <button className="btn btn-ghost" onClick={() => setSheetOpen(false)} disabled={submitting}>
              Назад
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
