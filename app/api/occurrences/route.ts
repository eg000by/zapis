import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient } from "@/lib/google";
import { decodeToken, contactKey } from "@/lib/link";

export const dynamic = "force-dynamic";

// Реальные ближайшие занятия еженедельной серии — для выбора конкретной даты при
// разовом переносе/отмене. В отличие от наивного «+7 дней», берём инстансы из Google
// Calendar: уже отменённые недели (EXDATE) не возвращаются, а перенесённые занятия
// (moved) исключаем — они управляются собственной строкой «Перенос».
//
// Важно: используем events.list(singleEvents,orderBy=startTime), а НЕ events.instances().
// Когда все занятия серии стали исключениями (напр. после покраски), instances() отдаёт
// их не по порядку — и обрезание по maxResults пропускало ближайшие даты. Разворот через
// events.list возвращает инстансы строго по возрастанию времени.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const decoded = decodeToken(url.searchParams.get("token"));
  if (!decoded.ok) {
    return NextResponse.json({ error: "Недействительная ссылка" }, { status: 403 });
  }
  const eventId = String(url.searchParams.get("eventId") || "");
  if (!eventId) return NextResponse.json({ error: "Не указана запись" }, { status: 400 });

  const cal = calendarClient();
  const key = contactKey(decoded.info);

  let ev;
  try {
    ev = (await cal.events.get({ calendarId: CALENDAR_ID, eventId })).data;
  } catch {
    return NextResponse.json({ error: "Запись не найдена" }, { status: 404 });
  }
  if (ev.extendedProperties?.private?.contactKey !== key) {
    return NextResponse.json({ error: "Это не ваша запись" }, { status: 403 });
  }

  const now = new Date();
  try {
    const res = await cal.events.list({
      calendarId: CALENDAR_ID,
      privateExtendedProperty: ["app=zapis", `contactKey=${key}`],
      timeMin: now.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 60,
    });
    const occurrences: string[] = [];
    for (const i of res.data.items || []) {
      if (i.status === "cancelled") continue;
      // Только инстансы этой серии (базовые повторы + её исключения).
      if (i.recurringEventId !== eventId && i.id !== eventId) continue;
      if (i.extendedProperties?.private?.moved === "1") continue;
      const s = i.start?.dateTime || i.start?.date;
      if (!s || new Date(s).getTime() < now.getTime()) continue;
      occurrences.push(new Date(s).toISOString());
      if (occurrences.length >= 8) break;
    }
    return NextResponse.json({ occurrences });
  } catch (e) {
    console.error("/api/occurrences error", e);
    return NextResponse.json({ occurrences: [] });
  }
}
