"use client";

import { useEffect, useState } from "react";
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

export default function BookingClient({
  token,
  parentName,
  greetName,
}: {
  token: string;
  parentName: string;
  greetName: string;
}) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState(0);

  const [picked, setPicked] = useState<Slot | null>(null);
  const [child, setChild] = useState("");
  const [subject, setSubject] = useState(SUBJECTS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [doneWhen, setDoneWhen] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/slots")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setLoadError(d.error);
        else setDays(d.days || []);
      })
      .catch(() => setLoadError("Не удалось загрузить расписание. Попробуйте позже."));
  }, []);

  async function submit() {
    if (!picked) return;
    if (!child.trim()) {
      setFormError("Впишите имя ребёнка");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, start: picked.start, child: child.trim(), subject }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "Не удалось записаться. Попробуйте другой слот.");
        setSubmitting(false);
        return;
      }
      setDoneWhen(data.when || null);
      setPicked(null);
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
          <p>
            Вы выбрали <b>{doneWhen}</b>. Преподаватель подтвердит запись, и время закрепится
            за вами. Спасибо!
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="hero">
        <h1>Здравствуйте, {greetName}! 👋</h1>
        <p>Выберите удобное время — и запишите ребёнка на занятие.</p>
        <span className="tz-badge">🕒 Время указано по Москве (МСК)</span>
      </div>

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
                    className="slot"
                    onClick={() => {
                      setPicked(s);
                      setFormError(null);
                    }}
                  >
                    {s.time}
                  </button>
                )
              )}
            </div>
            <p className="hint">Серые слоты уже заняты. Нажмите на свободное время для записи.</p>
          </div>
        </>
      )}

      {picked && (
        <div className="overlay" onClick={() => !submitting && setPicked(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Запись на занятие</h2>
            <p className="when">
              {days?.[activeDay].title}, {picked.time} (МСК)
            </p>

            <label htmlFor="child">Имя ребёнка</label>
            <input
              id="child"
              value={child}
              onChange={(e) => setChild(e.target.value)}
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

            {formError && <div className="error-text">{formError}</div>}

            <button className="btn" onClick={submit} disabled={submitting}>
              {submitting ? "Отправляем…" : "Записаться"}
            </button>
            <button className="btn btn-ghost" onClick={() => setPicked(null)} disabled={submitting}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
