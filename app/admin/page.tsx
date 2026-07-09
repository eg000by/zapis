import { headers } from "next/headers";
import { encodeToken } from "@/lib/link";
import { getOrCreateStudentLinkCode } from "@/lib/shortlink";
import { SUBJECTS } from "@/lib/config";
import { formatMskRange } from "@/lib/slots";
import { liveEventIdsForContact } from "@/lib/google";
import { getStudent, listStudents } from "@/lib/students";
import { listStudentLessons } from "@/lib/lessons";
import { listStudentPayments } from "@/lib/payments";
import type { Lesson, Payment, Student } from "@/lib/schema";
import AdminResult from "./AdminResult";

export const dynamic = "force-dynamic";

function baseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const h = headers();
  const host = h.get("host") || "localhost:3000";
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  return `${proto}://${host}`;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "⏳ ждёт",
  confirmed: "✅ подтверждено",
  done: "✔️ проведено",
  cancelled: "🚫 отменено",
};

const PAY_STATUS: Record<string, string> = {
  unpaid: "🔴 не оплачено",
  paid: "🟢 оплачено",
  canceled: "⚪ отменён",
};

const rub = (kopecks: number) => (kopecks / 100).toLocaleString("ru-RU");

function lessonWhen(l: Lesson): string {
  if (!l.occurrenceStart) return "—";
  const iso = l.occurrenceStart instanceof Date ? l.occurrenceStart.toISOString() : String(l.occurrenceStart);
  return formatMskRange(iso, 1);
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const get = (k: string) => {
    const v = searchParams[k];
    return (Array.isArray(v) ? v[0] : v) || "";
  };

  const key = get("key");
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret || key !== adminSecret) {
    return (
      <div className="wrap">
        <div className="center-note">
          <span className="emoji">🔒</span>
          <p>
            Доступ закрыт. Откройте страницу с правильным ключом: <code>/admin?key=…</code>
          </p>
        </div>
      </div>
    );
  }

  const view = get("view");
  const link = (params: Record<string, string>) => {
    const u = new URLSearchParams({ key, ...params });
    return `/admin?${u.toString()}`;
  };

  // ── Карточка ученика ────────────────────────────────────────────────
  if (view === "student") {
    const id = get("id");
    const confirmDelete = get("confirm") === "delete";
    let student: Student | null = null;
    let lessons: Lesson[] = [];
    let studentPayments: Payment[] = [];
    let dbError = false;
    try {
      student = await getStudent(id);
      if (student) {
        const all = await listStudentLessons(student.id);
        studentPayments = await listStudentPayments(student.id);
        // Сверка с календарём (источник правды): занятие, чьё событие удалено/отменено
        // (отмена на сайте, отклонение, удаление прямо в Google Calendar), не показываем.
        let liveIds: Set<string> | null = null;
        try {
          liveIds = await liveEventIdsForContact(student.contactKey);
        } catch (e) {
          console.error("admin card calendar reconcile failed", e);
        }
        lessons = all.filter((l) => {
          if (l.status === "cancelled") return false;
          if (liveIds && l.calendarEventId && !liveIds.has(l.calendarEventId)) return false;
          return true;
        });
      }
    } catch (e) {
      console.error("admin student card", e);
      dbError = true;
    }

    if (!student) {
      return (
        <div className="wrap">
          <div className="center-note">
            <span className="emoji">{dbError ? "⚠️" : "🤷"}</span>
            <p>{dbError ? "База недоступна (проверьте DATABASE_URL)." : "Ученик не найден."}</p>
            <p>
              <a href={link({})}>← К списку учеников</a>
            </p>
          </div>
        </div>
      );
    }

    let personalLink = "";
    try {
      const code = await getOrCreateStudentLinkCode(student.id, false);
      personalLink = `${baseUrl()}/z/${code}`;
    } catch (e) {
      console.error("admin short link failed", e);
      const token = encodeToken({
        name: student.name,
        subject: student.subject,
        tg: student.tg,
        trial: false,
        studentId: student.id,
      });
      personalLink = `${baseUrl()}/?t=${encodeURIComponent(token)}`;
    }

    return (
      <div className="wrap">
        <div className="hero">
          <p style={{ margin: 0 }}>
            <a href={link({})}>← Все ученики</a>
          </p>
          <h1>
            {student.name} {student.active ? "" : "· 🚫 архив"}
          </h1>
          <p>
            {student.subject}
            {student.tg ? ` · ${student.tg}` : ""} ·{" "}
            {student.rateKopecks > 0 ? `${student.rateKopecks / 100} ₽/час` : "ставка не задана"}
          </p>
        </div>

        <AdminResult link={personalLink} />

        <div className="card" style={{ marginTop: 16 }}>
          <label style={{ marginTop: 0 }}>Заметка по ученику</label>
          <form method="POST" action="/api/admin">
            <input type="hidden" name="key" value={key} />
            <input type="hidden" name="action" value="student.note" />
            <input type="hidden" name="studentId" value={student.id} />
            <textarea
              name="note"
              rows={3}
              defaultValue={student.note}
              placeholder="Цели, уровень, особенности…"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <button className="btn" type="submit">
              Сохранить заметку
            </button>
          </form>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <form method="POST" action="/api/admin" style={{ flex: 1, minWidth: 200 }}>
              <input type="hidden" name="key" value={key} />
              <input type="hidden" name="action" value="student.rate" />
              <input type="hidden" name="studentId" value={student.id} />
              <label style={{ marginTop: 0 }}>Ставка, ₽/час</label>
              <input
                name="rate"
                type="number"
                min={0}
                step={50}
                defaultValue={student.rateKopecks > 0 ? student.rateKopecks / 100 : ""}
                placeholder="напр. 1500"
              />
              <button className="btn" type="submit">
                Сохранить ставку
              </button>
            </form>
            <form method="POST" action="/api/admin" style={{ flex: 1, minWidth: 200 }}>
              <input type="hidden" name="key" value={key} />
              <input type="hidden" name="action" value="student.active" />
              <input type="hidden" name="studentId" value={student.id} />
              <input type="hidden" name="active" value={student.active ? "0" : "1"} />
              <label style={{ marginTop: 0 }}>Статус</label>
              <p className="hint" style={{ marginTop: 0 }}>
                Сейчас: {student.active ? "активен" : "в архиве"}
              </p>
              <button className="btn" type="submit">
                {student.active ? "В архив" : "Вернуть в активные"}
              </button>
            </form>
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <label style={{ marginTop: 0 }}>Оплаты</label>
          <p className="hint" style={{ marginTop: 0 }}>
            Счёт создаётся в «Мой налог» (СБП + чек автоматически). Сюда вставьте ссылку на
            оплату и отметьте «Оплачено», когда деньги придут.
          </p>

          {studentPayments.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
              {studentPayments.map((p) => (
                <div
                  key={p.id}
                  style={{ borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12 }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {rub(p.amountKopecks)} ₽ · {PAY_STATUS[p.status] || p.status}
                  </div>
                  {p.note && <div className="hint" style={{ marginTop: 2 }}>{p.note}</div>}
                  {p.payLink && (
                    <div style={{ marginTop: 4 }}>
                      <a href={p.payLink} target="_blank" rel="noreferrer">
                        Ссылка на оплату ↗
                      </a>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    {p.status !== "paid" ? (
                      <form method="POST" action="/api/admin">
                        <input type="hidden" name="key" value={key} />
                        <input type="hidden" name="action" value="payment.paid" />
                        <input type="hidden" name="studentId" value={student.id} />
                        <input type="hidden" name="paymentId" value={p.id} />
                        <button className="btn" type="submit">
                          Отметить оплачено
                        </button>
                      </form>
                    ) : (
                      <form method="POST" action="/api/admin">
                        <input type="hidden" name="key" value={key} />
                        <input type="hidden" name="action" value="payment.unpaid" />
                        <input type="hidden" name="studentId" value={student.id} />
                        <input type="hidden" name="paymentId" value={p.id} />
                        <button className="btn" type="submit">
                          Снять оплату
                        </button>
                      </form>
                    )}
                    <form method="POST" action="/api/admin">
                      <input type="hidden" name="key" value={key} />
                      <input type="hidden" name="action" value="payment.delete" />
                      <input type="hidden" name="studentId" value={student.id} />
                      <input type="hidden" name="paymentId" value={p.id} />
                      <button className="btn" type="submit">
                        Удалить
                      </button>
                    </form>
                  </div>
                  <form method="POST" action="/api/admin" style={{ marginTop: 8 }}>
                    <input type="hidden" name="key" value={key} />
                    <input type="hidden" name="action" value="payment.link" />
                    <input type="hidden" name="studentId" value={student.id} />
                    <input type="hidden" name="paymentId" value={p.id} />
                    <input
                      name="payLink"
                      defaultValue={p.payLink}
                      placeholder="Ссылка на оплату из «Мой налог»"
                    />
                    <button className="btn" type="submit">
                      Сохранить ссылку
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}

          <form method="POST" action="/api/admin" style={{ borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12 }}>
            <input type="hidden" name="key" value={key} />
            <input type="hidden" name="action" value="payment.create" />
            <input type="hidden" name="studentId" value={student.id} />
            <label style={{ marginTop: 0 }}>Новый счёт</label>
            <input name="amount" type="number" min={0} step={50} placeholder="Сумма, ₽" />
            {student.rateKopecks > 0 && (
              <p className="hint" style={{ marginTop: 4 }}>
                Ставка: {rub(student.rateKopecks)} ₽/час
              </p>
            )}
            <input name="note" placeholder="Комментарий (напр. «Март, 4 занятия»)" />
            <input name="payLink" placeholder="Ссылка на оплату из «Мой налог» (необязательно)" />
            <button className="btn" type="submit">
              Создать счёт
            </button>
          </form>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <label style={{ marginTop: 0 }}>Занятия</label>
          {lessons.length === 0 ? (
            <p className="hint">Пока нет занятий в базе. Они появятся после записи по ссылке.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {lessons.map((l) => (
                <div
                  key={l.id}
                  style={{ borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12 }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {lessonWhen(l)} · {STATUS_LABEL[l.status] || l.status}
                  </div>
                  <form method="POST" action="/api/admin" style={{ marginTop: 8 }}>
                    <input type="hidden" name="key" value={key} />
                    <input type="hidden" name="action" value="lesson.note" />
                    <input type="hidden" name="studentId" value={student.id} />
                    <input type="hidden" name="lessonId" value={l.id} />
                    <textarea
                      name="note"
                      rows={2}
                      defaultValue={l.note}
                      placeholder="Что прошли на занятии…"
                      style={{ width: "100%", boxSizing: "border-box" }}
                    />
                    <button className="btn" type="submit">
                      Сохранить
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ marginTop: 16, borderColor: "#dc2626" }}>
          <label style={{ marginTop: 0, color: "#dc2626" }}>Удалить ученика</label>
          <p className="hint" style={{ marginTop: 0 }}>
            Необратимо удаляет ученика вместе со всеми его занятиями, оплатами и ссылками на
            запись из базы. События в Google Calendar остаются — при необходимости удалите их
            там отдельно. Чаще безопаснее «В архив».
          </p>
          {confirmDelete ? (
            <form method="POST" action="/api/admin">
              <input type="hidden" name="key" value={key} />
              <input type="hidden" name="action" value="student.delete" />
              <input type="hidden" name="studentId" value={student.id} />
              <p style={{ fontWeight: 600, margin: "0 0 8px" }}>
                Точно удалить «{student.name}»? Это нельзя отменить.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn" type="submit" style={{ background: "#dc2626" }}>
                  Да, удалить навсегда
                </button>
                <a className="btn" href={link({ view: "student", id: student.id })}>
                  Отмена
                </a>
              </div>
            </form>
          ) : (
            <a
              className="btn"
              href={link({ view: "student", id: student.id, confirm: "delete" })}
              style={{ background: "#dc2626", display: "inline-block" }}
            >
              Удалить ученика…
            </a>
          )}
        </div>
      </div>
    );
  }

  // ── Список учеников + создание ─────────────────────────────────────
  const name = get("name").trim();
  const tg = get("tg").trim();
  const subject = get("subject").trim() || SUBJECTS[0];
  const trial = get("trial") === "on";

  let createdLink = "";
  if (name && SUBJECTS.includes(subject)) {
    // При создании ссылки заводим ученика в БД (best-effort) и зашиваем его id в токен.
    let studentId: string | undefined;
    try {
      const { upsertStudent } = await import("@/lib/students");
      const { contactKey } = await import("@/lib/link");
      const ck = contactKey({ name, subject, tg, trial });
      const s = await upsertStudent({ name, subject, tg, contactKey: ck });
      studentId = s.id;
    } catch (e) {
      console.error("admin create student", e);
    }
    if (studentId) {
      try {
        const code = await getOrCreateStudentLinkCode(studentId, trial);
        createdLink = `${baseUrl()}/z/${code}`;
      } catch (e) {
        console.error("admin create short link failed", e);
      }
    }
    if (!createdLink) {
      // Фолбэк (нет БД/studentId) — старый длинный формат, чтобы ссылка всё же была.
      const token = encodeToken({ name, subject, tg, trial, studentId });
      createdLink = `${baseUrl()}/?t=${encodeURIComponent(token)}`;
    }
  }

  let students: Student[] = [];
  let dbError = false;
  try {
    students = await listStudents();
  } catch (e) {
    console.error("admin list students", e);
    dbError = true;
  }

  return (
    <div className="wrap">
      <div className="hero">
        <h1>Ученики</h1>
        <p>Создайте персональную ссылку — ученик добавится в базу автоматически.</p>
      </div>

      <form className="card" method="GET" style={{ marginTop: 16 }}>
        <input type="hidden" name="key" value={key} />

        <label htmlFor="name">Имя ученика</label>
        <input id="name" name="name" defaultValue={name} placeholder="Например, Егор" />

        <label htmlFor="subject">Предмет</label>
        <select id="subject" name="subject" defaultValue={subject}>
          {SUBJECTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <label htmlFor="tg">Telegram (необязательно)</label>
        <input id="tg" name="tg" defaultValue={tg} placeholder="@egor" />

        <label className="check-row">
          <input type="checkbox" name="trial" defaultChecked={trial} />
          <span>Пробное — разовая запись на один день, без повтора</span>
        </label>

        <button className="btn" type="submit">
          Создать ссылку
        </button>
      </form>

      {createdLink && <AdminResult link={createdLink} />}

      <div className="card" style={{ marginTop: 20 }}>
        <label style={{ marginTop: 0 }}>Список учеников</label>
        {dbError ? (
          <p className="hint">База недоступна (проверьте переменную DATABASE_URL на Vercel).</p>
        ) : students.length === 0 ? (
          <p className="hint">Пока пусто — создайте первую ссылку выше.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {students.map((s) => (
              <a
                key={s.id}
                href={link({ view: "student", id: s.id })}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "10px 0",
                  borderTop: "1px solid var(--border, #e5e7eb)",
                  textDecoration: "none",
                }}
              >
                <span>
                  <b>{s.name}</b> · {s.subject}
                  {s.tg ? ` · ${s.tg}` : ""}
                </span>
                <span className="hint" style={{ margin: 0 }}>
                  {s.active ? "→" : "архив →"}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
