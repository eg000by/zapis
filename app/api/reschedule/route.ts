import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient, fetchBusy } from "@/lib/google";
import {
  blockSpanMinutes,
  buildRecurrence,
  formatMskRange,
  weeklyOccurrences,
  windowBounds,
} from "@/lib/slots";
import { decodeToken, contactKey } from "@/lib/link";
import { updateLessonByEvent } from "@/lib/lessons";
import { notifyRequest } from "@/lib/telegram";
import { PENDING_PREFIX, TIMEZONE } from "@/lib/config";

export const dynamic = "force-dynamic";

// Перенос записи на другое время. Разрешён только для своих заявок.
// После переноса запись снова становится «ожидает подтверждения».
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
  const contact = decoded.info;
  const eventId = String(body?.eventId || "");
  const startIso = String(body?.start || "");
  if (!eventId || !startIso) {
    return NextResponse.json({ error: "Не хватает данных для переноса" }, { status: 400 });
  }

  const cal = calendarClient();
  const key = contactKey(contact);

  let ev;
  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId });
    ev = res.data;
  } catch {
    return NextResponse.json({ error: "Запись не найдена" }, { status: 404 });
  }
  const priv = ev.extendedProperties?.private || {};
  if (priv.contactKey !== key) {
    return NextResponse.json({ error: "Это не ваша запись" }, { status: 403 });
  }

  const weeks = Number(priv.weeks) || 1;
  const student = priv.student || "";
  const subject = priv.subject || "";
  // Ревизия переноса: растёт с каждым повторным переносом до подтверждения. Кнопка
  // подтверждения несёт эту ревизию, и старое уведомление при нажатии распознаётся
  // как устаревшее (иначе подтверждение старого слота применяло бы последний слот).
  const rev = (Number(priv.rev) || 0) + 1;

  // Сохраняем длину блока: переносим весь блок, а не только первое занятие.
  // Число занятий берём из extendedProperties; для старых событий — из длительности.
  const evStart = ev.start?.dateTime;
  const evEnd = ev.end?.dateTime;
  const lessons =
    Number(priv.lessons) ||
    (evStart && evEnd
      ? Math.max(1, Math.round((new Date(evEnd).getTime() - new Date(evStart).getTime()) / 3600000))
      : 1);

  try {
    const now = new Date();
    const { timeMin, timeMax } = windowBounds(now);

    const occ = weeklyOccurrences(startIso, weeks);
    let far = timeMax.getTime();
    const lastEnd = new Date(occ[occ.length - 1]).getTime() + blockSpanMinutes(lessons) * 60000;
    if (lastEnd > far) far = lastEnd;

    // Занятость без самой этой записи (иначе она конфликтовала бы с собой).
    const busy = await fetchBusy(timeMin, new Date(far + 60000), eventId);

    const r = buildRecurrence(startIso, weeks, busy, now, lessons);
    if (!r.ok) {
      return NextResponse.json(
        { error: `${formatMskRange(startIso, lessons)}: ${r.reason || "слот недоступен"}` },
        { status: 409 }
      );
    }

    const end = new Date(new Date(startIso).getTime() + blockSpanMinutes(lessons) * 60000);
    await cal.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: {
        summary: `${PENDING_PREFIX}${student} — ${subject}`,
        status: "tentative",
        start: { dateTime: startIso, timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
        ...(r.recurrence ? { recurrence: r.recurrence } : {}),
        extendedProperties: {
          private: { ...priv, status: "pending", lessons: String(lessons), rev: String(rev) },
        },
      },
    });

    // CRM (best-effort): переносим занятие и возвращаем в статус ожидания.
    try {
      await updateLessonByEvent(eventId, { status: "pending", occurrenceStart: new Date(startIso) });
    } catch (e) {
      console.error("CRM lesson reschedule sync failed", e);
    }

    const suffix = weeks > 1 ? " (еженедельно)" : "";
    const when = `${formatMskRange(startIso, lessons)}${suffix}`;

    try {
      await notifyRequest({
        eventId,
        name: student || contact.name,
        tg: contact.tg,
        subject,
        when,
        header: "🔄 <b>Перенос записи</b> — нужно подтвердить",
        rev,
      });
    } catch (e) {
      console.error("Telegram notify (reschedule) failed", e);
    }

    return NextResponse.json({ ok: true, when });
  } catch (e) {
    console.error("/api/reschedule error", e);
    return NextResponse.json({ error: "Не удалось перенести запись" }, { status: 500 });
  }
}
