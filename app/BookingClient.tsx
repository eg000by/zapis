"use client";

import { useEffect, useMemo, useState } from "react";
import { groupConsecutive } from "@/lib/blocks";
import { SLOT_MINUTES, SLOT_STEP_MINUTES } from "@/lib/config";

interface Slot {
  start: string;
  time: string;
  busy: boolean;
}
interface Day {
  date: string;
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
  weeks: number;
  lessons: number;
}

interface MyPayment {
  id: string;
  amountKopecks: number;
  note: string;
  payLink: string;
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
  if (lessons <= 1) return `${s} (МСК)`;
  const spanMin = (lessons - 1) * SLOT_STEP_MINUTES + SLOT_MINUTES;
  const end = new Date(new Date(iso).getTime() + spanMin * 60000);
  return `${s}–${hmMsk(end.toISOString())} (МСК)`;
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
  const [rescheduleFor, setRescheduleFor] = useState<MyEvent | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const slotInfo = useMemo(() => {
    const m = new Map<string, { time: string; title: string }>();
    (days || []).forEach((d) => d.slots.forEach((s) => m.set(s.start, { time: s.time, title: d.title })));
    return m;
  }, [days]);

  // Подряд идущие часы показываем одним блоком («10:00–13:00»).
  const blocks = useMemo(() => groupConsecutive(selected), [selected]);

  // Если в окне подтверждения убрали все слоты — закрываем окно.
  useEffect(() => {
    if (sheetOpen && selected.length === 0) setSheetOpen(false);
  }, [sheetOpen, selected]);

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
    setSelected((cur) =>
      cur.includes(start) ? cur.filter((s) => s !== start) : [...cur, start]
    );
  }

  function removeSlots(slots: string[]) {
    setSelected((cur) => cur.filter((s) => !slots.includes(s)));
  }

  async function pickForReschedule(start: string) {
    if (!rescheduleFor) return;
    setBusyAction(true);
    setNotice(null);
    try {
      const res = await fetch("/api/reschedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, eventId: rescheduleFor.id, start }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Например, слот заняли за секунду до нас — обновляем сетку, старая бронь цела.
        setNotice(data.error || "Не удалось перенести запись. Ваше прежнее время осталось за вами.");
        await refreshSlots(false);
      } else {
        setNotice(`Перенесено на ${data.when}. Ждём подтверждения преподавателя.`);
        setRescheduleFor(null);
        loadSlots();
        loadMy();
      }
    } catch {
      setNotice("Ошибка сети. Попробуйте ещё раз.");
    } finally {
      setBusyAction(false);
    }
  }

  async function cancelEvent(ev: MyEvent) {
    if (!confirm(`Отменить запись «${ev.student} — ${ev.subject}»?`)) return;
    setBusyAction(true);
    setNotice(null);
    try {
      const res = await fetch("/api/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, eventId: ev.id }),
      });
      const data = await res.json();
      if (!res.ok) setNotice(data.error || "Не удалось отменить запись.");
      else {
        setNotice("Запись отменена.");
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
    if (rescheduleFor) {
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
      setSubmitting(false);
      loadSlots();
      loadMy();
    } catch {
      setFormError("Ошибка сети. Попробуйте ещё раз.");
      setSubmitting(false);
    }
  }

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
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="hero">
        <h1>Здравствуйте, {greetName}! 👋</h1>
        <p>
          {trial ? "Выберите время для пробного занятия" : "Выберите удобное время для занятий"} по
          предмету «<b>{subject}</b>».
        </p>
        <span className="tz-badge">🕒 Время указано по Москве (МСК)</span>
      </div>

      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {payments.length > 0 && (
        <div className="card my-card">
          <div className="day-title">К оплате</div>
          {payments.map((p) => (
            <div key={p.id} className="my-row">
              <div className="my-info">
                <b>{(p.amountKopecks / 100).toLocaleString("ru-RU")} ₽</b>
                {p.note && <span className="my-when">{p.note}</span>}
              </div>
              <div className="my-actions">
                {p.payLink ? (
                  <a
                    className="mini"
                    href={p.payLink}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                  >
                    Оплатить по СБП ↗
                  </a>
                ) : (
                  <span className="badge wait">ждём ссылку на оплату</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {my && my.length > 0 && (
        <div className="card my-card">
          <div className="day-title">Ваши записи</div>
          {my.map((ev) => (
            <div key={ev.id} className="my-row">
              <div className="my-info">
                <b>{ev.student} — {ev.subject}</b>
                <span className="my-when">
                  {ev.recurring ? fmtSlotMsk(ev.start, ev.lessons) : fmtMsk(ev.start, ev.lessons)}
                  {ev.recurring ? " · еженедельно" : ""}
                </span>
                <span className={`badge ${ev.status === "confirmed" ? "ok" : "wait"}`}>
                  {ev.status === "confirmed" ? "✅ подтверждено" : "⏳ ждёт подтверждения"}
                </span>
              </div>
              <div className="my-actions">
                <button
                  className="mini"
                  disabled={busyAction}
                  onClick={() => {
                    setRescheduleFor(ev);
                    setSelected([]);
                    setNotice("Выберите новое время ниже для переноса.");
                  }}
                >
                  Перенести
                </button>
                <button className="mini danger" disabled={busyAction} onClick={() => cancelEvent(ev)}>
                  Отменить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {rescheduleFor && (
        <div className="reschedule-bar">
          <span>
            Переносим: <b>{rescheduleFor.student} — {rescheduleFor.subject}</b>. Выберите новое время.
          </span>
          <button className="mini" onClick={() => { setRescheduleFor(null); setNotice(null); }}>
            Отмена
          </button>
        </div>
      )}

      {loadError && (
        <div className="center-note">
          <span className="emoji">😕</span>
          <p>{loadError}</p>
        </div>
      )}

      {!loadError && days === null && <div className="spinner" />}

      {!loadError && days !== null && days.length === 0 && (
        <div className="center-note">
          <span className="emoji">📭</span>
          <p>Свободных слотов на ближайшее время нет. Загляните чуть позже.</p>
        </div>
      )}

      {!loadError && days !== null && days.length > 0 && (
        <>
          <div className="day-nav">
            {days.map((d, i) => (
              <button
                key={d.date}
                className={`day-chip ${i === activeDay ? "active" : ""}`}
                onClick={() => setActiveDay(i)}
              >
                <b>{d.weekday}</b>
              </button>
            ))}
          </div>

          <div className="card">
            <div className="day-title">{days[activeDay].title}</div>
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
              {rescheduleFor
                ? "Нажмите на свободное время — запись переедет на него."
                : "Можно выбрать несколько слотов. Серые — уже заняты."}
            </p>
          </div>
        </>
      )}

      {/* Нижняя панель выбора */}
      {!rescheduleFor && selected.length > 0 && !sheetOpen && (
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
              {blocks.map((b) => {
                const title = slotInfo.get(b.start)?.title || "";
                const startLabel = slotInfo.get(b.start)?.time || hmMsk(b.start);
                const timeLabel =
                  b.slots.length > 1 ? `${startLabel}–${hmMsk(b.end)}` : startLabel;
                return (
                  <div key={b.start} className="summary-row">
                    <div className="summary-when">
                      {title}, {timeLabel} (МСК)
                      <span className="summary-tag">{trial ? "разово" : "еженедельно"}</span>
                    </div>
                    <button
                      className="chip-x"
                      onClick={() => removeSlots(b.slots)}
                      aria-label="Убрать"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            <p className="sheet-note">
              {trial
                ? "Разовое пробное занятие. Отменить или перенести можно в разделе «Ваши записи»."
                : "Время закрепится за вами каждую неделю. Перенести или отменить можно в разделе «Ваши записи»."}
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
