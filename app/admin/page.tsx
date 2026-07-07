import { headers } from "next/headers";
import { encodeParentToken } from "@/lib/link";
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

export default function AdminPage({
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
          <p>Доступ закрыт. Откройте страницу с правильным ключом: <code>/admin?key=…</code></p>
        </div>
      </div>
    );
  }

  const name = get("name").trim();
  const tg = get("tg").trim();

  let link = "";
  if (name) {
    const token = encodeParentToken({ name, tg });
    link = `${baseUrl()}/?t=${encodeURIComponent(token)}`;
  }

  return (
    <div className="wrap">
      <div className="hero">
        <h1>Генератор ссылок</h1>
        <p>Создайте персональную ссылку для родителя ученика.</p>
      </div>

      <form className="card" method="GET" style={{ marginTop: 16 }}>
        <input type="hidden" name="key" value={key} />

        <label htmlFor="name">Имя родителя</label>
        <input id="name" name="name" defaultValue={name} placeholder="Например, Мама Марина" />

        <label htmlFor="tg">Telegram (необязательно)</label>
        <input id="tg" name="tg" defaultValue={tg} placeholder="@marina" />

        <button className="btn" type="submit">
          Создать ссылку
        </button>
      </form>

      {link && <AdminResult link={link} />}
    </div>
  );
}
