import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient } from "@/lib/google";
import { decodeToken, contactKey } from "@/lib/link";
import { setLessonStatusByEvent } from "@/lib/lessons";
import { formatMskRange } from "@/lib/slots";
import { escapeHtml, sendOwner } from "@/lib/telegram";
import { recolorStudent } from "@/lib/coloring";

export const dynamic = "force-dynamic";

// Отмена записи. Разрешена только для своих заявок (contactKey совпадает).
// mode: "all" — вся еженедельная серия (по умолчанию); "once" — только одно занятие
// серии (occStart — время того занятия). Об отмене уведомляем владельца в Telegram.
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
  const mode = body?.mode === "once" ? "once" : "all";
  const occStartIso = String(body?.occStart || "");

  const cal = calendarClient();
  const key = contactKey(decoded.info);

  let ev;
  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId });
    ev = res.data;
    if (ev.extendedProperties?.private?.contactKey !== key) {
      return NextResponse.json({ error: "Это не ваша запись" }, { status: 403 });
    }
  } catch {
    // Уже нет события — считаем, что отменять нечего.
    return NextResponse.json({ ok: true });
  }

  const priv = ev.extendedProperties?.private || {};
  const student = priv.student || priv.name || "";
  const subject = priv.subject || "";
  const tg = priv.tg || "";
  const studentId = priv.studentId;
  const lessons =
    Number(priv.lessons) ||
    (ev.start?.dateTime && ev.end?.dateTime
      ? Math.max(
          1,
          Math.round(
            (new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime()) / 3600000
          )
        )
      : 1);
  const isSeries = Array.isArray(ev.recurrence) && ev.recurrence.length > 0;

  // Что именно отменили (для уведомления и CRM).
  let cancelledOnce = false;
  try {
    if (mode === "once" && isSeries && !ev.recurringEventId) {
      // Отмена одного занятия серии: удаляем конкретный инстанс (в серию добавится EXDATE),
      // остальные недели сохраняются.
      if (!occStartIso) {
        return NextResponse.json({ error: "Не выбрано занятие для отмены" }, { status: 400 });
      }
      const w0 = new Date(occStartIso).getTime();
      const insts = await cal.events.instances({
        calendarId: CALENDAR_ID,
        eventId,
        timeMin: new Date(w0 - 60000).toISOString(),
        timeMax: new Date(w0 + 60000).toISOString(),
        maxResults: 5,
      });
      // Ищем именно наступление серии на occStart: сверяем originalStartTime, чтобы не
      // удалить другой (ранее перенесённый) инстанс, случайно стоящий на этом времени.
      const inst = (insts.data.items || []).find((i) => {
        if (i.status === "cancelled" || !i.id) return false;
        if (i.extendedProperties?.private?.moved === "1") return false;
        const orig = i.originalStartTime?.dateTime || i.start?.dateTime;
        return !!orig && Math.abs(new Date(orig).getTime() - w0) < 60000;
      });
      if (!inst) {
        return NextResponse.json(
          { error: "Это занятие не найдено (возможно, уже отменено)." },
          { status: 404 }
        );
      }
      await cal.events.delete({ calendarId: CALENDAR_ID, eventId: inst.id! });
      cancelledOnce = true;
    } else {
      // Отмена всей серии / разового занятия / отдельного перенесённого занятия.
      await cal.events.delete({ calendarId: CALENDAR_ID, eventId });
      // CRM (best-effort): помечаем занятие отменённым, чтобы карточка не показывала фантом.
      try {
        await setLessonStatusByEvent(eventId, "cancelled");
      } catch (e) {
        console.error("CRM lesson cancel sync failed", e);
      }
    }
  } catch (e) {
    console.error("/api/cancel error", e);
    return NextResponse.json({ error: "Не удалось отменить запись" }, { status: 500 });
  }

  // Пересчёт цветов (баланс оплат мог перераспределиться на оставшиеся занятия).
  if (studentId) {
    try {
      await recolorStudent(studentId);
    } catch (e) {
      console.error("recolor after cancel failed", e);
    }
  }

  // Уведомление владельцу в Telegram.
  const what = cancelledOnce
    ? `одно занятие: ${formatMskRange(occStartIso, lessons)}`
    : isSeries
      ? "вся серия (еженедельно)"
      : ev.start?.dateTime
        ? formatMskRange(ev.start.dateTime, lessons)
        : "";
  try {
    await sendOwner(
      `🚫 <b>Отмена записи</b>\n\n🧑‍🎓 ${escapeHtml(student)}\n📚 ${escapeHtml(subject)}\n🗓 ${escapeHtml(
        what
      )}${tg ? `\n✈️ ${escapeHtml(tg)}` : ""}`
    );
  } catch (e) {
    console.error("Telegram notify (cancel) failed", e);
  }

  return NextResponse.json({ ok: true });
}
