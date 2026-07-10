import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient, fetchBusy } from "@/lib/google";
import { blockSpanMinutes, formatMskRange, validateSlot, windowBounds } from "@/lib/slots";
import { decodeToken, contactKey } from "@/lib/link";
import { escapeHtml, sendOwner } from "@/lib/telegram";
import { recolorStudent } from "@/lib/coloring";
import { TIMEZONE } from "@/lib/config";

export const dynamic = "force-dynamic";

// Возврат разово перенесённого занятия на его исходное время (до переноса).
// Работает только с инстансом-исключением (moved=1). Прежний слот той недели был
// освобождён переносом, поэтому обычно свободен; если туда встало другое занятие —
// возвращаем ошибку с понятным сообщением.
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
  if (!eventId) return NextResponse.json({ error: "Не указана запись" }, { status: 400 });

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
  if (priv.moved !== "1" || !priv.origStart) {
    return NextResponse.json({ error: "Это занятие не переносилось — возвращать нечего." }, { status: 409 });
  }

  const student = priv.student || "";
  const subject = priv.subject || "";
  const origStart = String(priv.origStart);
  const lessons = Number(priv.lessons) || 1;

  try {
    const now = new Date();
    const { timeMin, timeMax } = windowBounds(now);
    const far = Math.max(
      timeMax.getTime(),
      new Date(origStart).getTime() + blockSpanMinutes(lessons) * 60000
    );
    // Занятость без самого этого занятия (иначе оно конфликтовало бы с собой).
    const busy = await fetchBusy(timeMin, new Date(far + 60000), eventId);
    const v = validateSlot(origStart, busy, now, lessons);
    if (!v.ok) {
      const msg =
        v.reason === "Слот уже занят"
          ? "На прежнее время уже поставлено другое занятие — вернуть не получилось. Перенесите на другое свободное время."
          : v.reason === "Это время уже прошло"
            ? "Прежнее время этого занятия уже прошло — вернуть нельзя."
            : `Не удалось вернуть: ${v.reason || "прежнее время недоступно"}.`;
      return NextResponse.json({ error: msg }, { status: 409 });
    }

    const end = new Date(new Date(origStart).getTime() + blockSpanMinutes(lessons) * 60000);
    const cleanSummary = (ev.summary || `${student} — ${subject}`).replace("⏳ ", "");
    // Возвращаем на исходное время и подтверждаем сразу (это был утверждённый слот серии).
    await cal.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: {
        summary: cleanSummary,
        status: "confirmed",
        start: { dateTime: origStart, timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
        extendedProperties: { private: { status: "confirmed", moved: "", origStart: "", rev: "" } },
      },
    });

    if (priv.studentId) {
      try {
        await recolorStudent(priv.studentId);
      } catch (e) {
        console.error("recolor after return failed", e);
      }
    }

    const when = formatMskRange(origStart, lessons);
    try {
      await sendOwner(
        `↩️ <b>Занятие возвращено на прежнее время</b>\n\n🧑‍🎓 ${escapeHtml(student)}\n📚 ${escapeHtml(
          subject
        )}\n🕒 ${escapeHtml(when)}`
      );
    } catch (e) {
      console.error("Telegram notify (return) failed", e);
    }

    return NextResponse.json({ ok: true, when });
  } catch (e) {
    console.error("/api/return error", e);
    return NextResponse.json({ error: "Не удалось вернуть занятие" }, { status: 500 });
  }
}
