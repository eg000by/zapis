import { decodeParentToken } from "@/lib/link";
import BookingClient from "./BookingClient";

export const dynamic = "force-dynamic";

export default function Page({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const tokenRaw = searchParams.t;
  const token = Array.isArray(tokenRaw) ? tokenRaw[0] : tokenRaw;
  const parent = decodeParentToken(token);

  if (!parent) {
    return (
      <div className="wrap">
        <div className="center-note">
          <span className="emoji">🔗</span>
          <p>
            Похоже, ссылка неполная или устарела.
            <br />
            Попросите преподавателя прислать вашу персональную ссылку для записи.
          </p>
        </div>
      </div>
    );
  }

  const firstName = parent.name.trim().split(/\s+/).slice(-1)[0] || parent.name;

  return <BookingClient token={token as string} parentName={parent.name} greetName={firstName} />;
}
