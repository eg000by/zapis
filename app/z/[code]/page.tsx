import { decodeToken } from "@/lib/link";
import { getTokenByCode } from "@/lib/shortlink";
import BookingClient from "../../BookingClient";

export const dynamic = "force-dynamic";

// Короткая ссылка записи: код → подписанный токен (из БД) → та же страница записи,
// что и на /?t=, но длинный токен в адресе не светится.
export default async function ShortLinkPage({ params }: { params: { code: string } }) {
  let token: string | null = null;
  try {
    token = await getTokenByCode(params.code);
  } catch (e) {
    console.error("shortlink lookup failed", e);
  }

  const decoded = decodeToken(token);
  if (!decoded.ok) {
    return (
      <div className="wrap">
        <div className="center-note">
          <span className="emoji">🔗</span>
          <p>
            Похоже, ссылка неверная или больше не действует.
            <br />
            Попросите преподавателя прислать вашу персональную ссылку для записи.
          </p>
        </div>
      </div>
    );
  }

  const contact = decoded.info;
  const firstName = contact.name.trim().split(/\s+/).slice(-1)[0] || contact.name;

  return (
    <BookingClient
      token={token as string}
      greetName={firstName}
      subject={contact.subject}
      trial={contact.trial}
    />
  );
}
