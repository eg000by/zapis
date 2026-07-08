import { headers } from "next/headers";
import { encodeToken } from "@/lib/link";
import { SUBJECTS } from "@/lib/config";
import { formatMskRange } from "@/lib/slots";
import { getStudent, listStudents } from "@/lib/students";
import { listStudentLessons } from "@/lib/lessons";
import type { Lesson, Student } from "@/lib/schema";
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
    let student: Student | null = null;
    let lessons: Lesson[] = [];
    let dbError = false;
    try {
      student = await getStudent(id);
      if (student) lessons = await listStudentLessons(student.id);
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

    const token = encodeToken({
      name: student.name,
      subject: student.subject,
      tg: student.tg,
      trial: false,
      studentId: student.id,
    });
    const personalLink = `${baseUrl()}/?t=${encodeURIComponent(token)}`;

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
    const token = encodeToken({ name, subject, tg, trial, studentId });
    createdLink = `${baseUrl()}/?t=${encodeURIComponent(token)}`;
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
