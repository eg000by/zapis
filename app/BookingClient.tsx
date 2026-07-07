"use client";

import { useEffect, useMemo, useState } from "react";
import { SUBJECTS } from "@/lib/config";

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
}

function fmtMsk(iso: string): string {
  const s = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
  return `${s} (МСК)`;
}

export default function BookingClient({
  token,
  greetName,
}: {
  token: string;
  greetName: string;
}) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState(0);

  // Выбранные слоты (ISO начала), в порядке выбора.
  const [selected, setSelected] = useState<string[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [student, setStudent] = useState("");
  const [subject, setSubject] = useState(SUBJECTS[0]);
  const [repeat, setRepeat] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [doneWhen, setDoneWhen] = useState<string | null>(null);

  // Мои записи.
  const [my, setMy] = useState<MyEvent[] | null>(null);
  const [rescheduleFor, setRescheduleFor] = useState<MyEvent | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const slotInfo = useMemo(() => {
    const m = new Map<string, { time: string; title: string }>();
    (days || []).forEach((d) => d.slots.forEach((s) => m.set(s.start, { time: s.time, title: d.title })));
    return m;
  }, [days]);

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
      .then((d) => setMy(d.events || []))
      .catch(() => setMy([]));
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
        setNotice(data.error || "Не удалось перенести запись.");
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
    if (!student.trim()) {
      setFormError("Впишите имя ученика");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          starts: selected,
          student: student.trim(),
          subject,
          repeat,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "Не удалось записаться. Попробуйте другой слот.");
        setSubmitting(false);
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
        <p>Выберите удобное время — и запишитесь на занятие.</p>
        <span className="tz-badge">🕒 Время указано по Москве (МСК)</span>
      </div>

      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice}
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
                  {fmtMsk(ev.start)}
                  {ev.recurring ? " · еженедельно (полгода)" : ""}
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
                <small>{d.weekday}</small>
                <b>{Number(d.date.slice(8, 10))}</b>
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
            Записать →
          </button>
        </div>
      )}

      {sheetOpen && (
        <div className="overlay" onClick={() => !submitting && setSheetOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Запись на занятие</h2>

            <div className="chips">
              {selected.map((st) => (
                <span key={st} className="chip">
                  {slotInfo.get(st)?.title}, {slotInfo.get(st)?.time}
                  <button className="chip-x" onClick={() => toggleSlot(st)} aria-label="Убрать">
                    ×
                  </button>
                </span>
              ))}
            </div>

            <label htmlFor="student">Имя ученика</label>
            <input
              id="student"
              value={student}
              onChange={(e) => setStudent(e.target.value)}
              placeholder="Например, Егор"
              autoFocus
            />

            <label htmlFor="subject">Предмет</label>
            <select id="subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
              {SUBJECTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <label className="check-row">
              <input
                type="checkbox"
                checked={repeat}
                onChange={(e) => setRepeat(e.target.checked)}
              />
              <span>Повторять каждую неделю (на полгода вперёд)</span>
            </label>

            {formError && <div className="error-text">{formError}</div>}

            <button className="btn" onClick={submit} disabled={submitting || selected.length === 0}>
              {submitting
                ? "Отправляем…"
                : `Записать${selected.length > 1 ? ` (${selected.length})` : ""}`}
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
