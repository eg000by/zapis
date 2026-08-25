import { decodeToken } from "@/lib/link";
import { TEACHER_TG, teacherTgUrl } from "@/lib/config";
import BookingClient from "./BookingClient";
import Icon from "./Icon";

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
          <Icon name={expired ? "hourglass" : "link"} className="ico-lg" />
          <p>
            {expired ? (
              <>
                Срок действия ссылки истёк.
                <br />
                Напишите преподавателю{TEACHER_TG ? " " : ""}
                {TEACHER_TG && (
                  <a href={teacherTgUrl()} target="_blank" rel="noreferrer">
                    @{TEACHER_TG}
                  </a>
                )}{" "}
                — он пришлёт новую ссылку. Уже подтверждённые записи остаются в силе.
              </>
            ) : (
              <>
                Похоже, ссылка неполная или неверная.
                <br />
                Попросите преподавателя{TEACHER_TG ? " " : ""}
                {TEACHER_TG && (
                  <a href={teacherTgUrl()} target="_blank" rel="noreferrer">
                    @{TEACHER_TG}
                  </a>
                )}{" "}
                прислать вашу персональную ссылку для записи.
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
