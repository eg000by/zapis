"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { groupConsecutive } from "@/lib/blocks";
import { SLOT_MINUTES, SLOT_STEP_MINUTES } from "@/lib/config";
import { shiftIntoWeekOf } from "@/lib/slots";
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

  function loadSlots() {
    setDays(null);
    fetch("/api/slots")
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
        setNextLesson(d.nextLesson || null);
      })
      .catch(() => setMy([]));
  }

  // Тихо обновляет сетку (без спиннера). Если prune — убирает из выбора слоты,
  // которые только что заняли. Возвращает оставшиеся выбранные слоты.
  async function refreshSlots(prune = false): Promise<string[]> {
    try {
      const d = await fetch("/api/slots").then((r) => r.json());
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
    loadSlots();
    loadMy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Для разового переноса слот сетки сдвигаем в неделю переносимого занятия.
    const target = rsMode === "once" && rsOcc ? shiftIntoWeekOf(start, rsOcc) : start;
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
        loadSlots();
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
      if (confirm(`Отменить перенесённое занятие «${ev.student} — ${ev.subject}»?`)) {
        doCancel(ev, "once");
      }
      return;
    }
    if (!ev.recurring) {
      if (confirm(`Отменить запись «${ev.student} — ${ev.subject}»?`)) doCancel(ev, "all");
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
        loadSlots();
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
        loadSlots();
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
      loadSlots();
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
          {rsKind === "cancel" ? "Отменяем" : "Переносим"}: <b>{rsEvent.student} — {rsEvent.subject}</b>
          {" · "}
          {fmtSlotMsk(rsEvent.start, rsEvent.lessons)}
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
                  if (confirm(`Отменить всю серию «${rsEvent.student} — ${rsEvent.subject}»?`)) {
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

      {/* Записи — выше денег: расписание для ученика главнее счёта. */}
      {my && my.length > 0 && (
        <div className="card my-card">
          <div className="day-title">Ваши записи</div>
          {my.map((ev) => (
            <div key={ev.id} className="my-item">
              <div className="my-row">
                <div className="my-info">
                  <b>{ev.student} — {ev.subject}</b>
                  {ev.moved ? (
                    <>
                      <span className="my-when">
                        {ev.origStart ? `${fmtMsk(ev.origStart, ev.lessons)} → ` : ""}
                        {fmtMsk(ev.start, ev.lessons)}
                      </span>
                      <span className="badge move">🔄 перенос</span>
                    </>
                  ) : (
                    <span className="my-when">
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
