import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient } from "@/lib/google";
import { decodeToken, contactKey } from "@/lib/link";
import { setLessonStatusByEvent } from "@/lib/lessons";

export const dynamic = "force-dynamic";

// Отмена записи. Разрешена только для своих заявок (contactKey совпадает).
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const decoded = decodeToken(body?.token);
  if (!decoded.ok) {
    return NextResponse.json({ error: "Недействительная ссылка" }, { status: 403 });
  }
  const eventId = String(body?.eventId || "");
  if (!eventId) return NextResponse.json({ error: "Не указана запись" }, { status: 400 });

  const cal = calendarClient();
  const key = contactKey(decoded.info);

  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId });
    if (res.data.extendedProperties?.private?.contactKey !== key) {
      return NextResponse.json({ error: "Это не ваша запись" }, { status: 403 });
    }
  } catch {
    // Уже нет события — считаем, что отменять нечего.
    return NextResponse.json({ ok: true });
  }

  try {
    await cal.events.delete({ calendarId: CALENDAR_ID, eventId });
  } catch (e) {
    console.error("/api/cancel error", e);
    return NextResponse.json({ error: "Не удалось отменить запись" }, { status: 500 });
  }

  // CRM (best-effort): помечаем занятие отменённым, чтобы карточка не показывала фантом.
  try {
    await setLessonStatusByEvent(eventId, "cancelled");
  } catch (e) {
    console.error("CRM lesson cancel sync failed", e);
  }

  return NextResponse.json({ ok: true });
}
