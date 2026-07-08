import { decodeToken } from "@/lib/link";
import BookingClient from "./BookingClient";

export const dynamic = "force-dynamic";

export default function Page({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const tokenRaw = searchParams.t;
  const token = Array.isArray(tokenRaw) ? tokenRaw[0] : tokenRaw;
  const decoded = decodeToken(token);

  if (!decoded.ok) {
    const expired = decoded.reason === "expired";
    return (
      <div className="wrap">
        <div className="center-note">
          <span className="emoji">{expired ? "⌛" : "🔗"}</span>
          <p>
            {expired ? (
              <>
                Срок действия ссылки истёк.
                <br />
                Напишите преподавателю — он пришлёт новую ссылку. Уже подтверждённые записи
                остаются в силе.
              </>
            ) : (
              <>
                Похоже, ссылка неполная или неверная.
                <br />
                Попросите преподавателя прислать вашу персональную ссылку для записи.
              </>
            )}
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
