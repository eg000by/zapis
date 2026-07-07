import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient, fetchBusy } from "@/lib/google";
import { formatMsk, validateSlot, windowBounds } from "@/lib/slots";
import { decodeParentToken } from "@/lib/link";
import { notifyRequest } from "@/lib/telegram";
import { PENDING_PREFIX, SUBJECTS, TIMEZONE } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const parent = decodeParentToken(body?.token);
  if (!parent) {
    return NextResponse.json(
      { error: "Недействительная ссылка. Попросите преподавателя прислать персональную ссылку." },
      { status: 403 }
    );
  }

  const child = String(body?.child || "").trim();
  const subject = String(body?.subject || "").trim();
  const startIso = String(body?.start || "");

  if (!child) return NextResponse.json({ error: "Укажите имя ребёнка" }, { status: 400 });
  if (!SUBJECTS.includes(subject)) {
    return NextResponse.json({ error: "Выберите предмет" }, { status: 400 });
  }

  try {
    const now = new Date();
    const { timeMin, timeMax } = windowBounds(now);
    const busy = await fetchBusy(timeMin, timeMax);

    // Повторно проверяем, что слот всё ещё свободен (защита от гонки).
    const check = validateSlot(startIso, busy, now);
    if (!check.ok || !check.end) {
      return NextResponse.json({ error: check.reason || "Слот недоступен" }, { status: 409 });
    }

    const when = formatMsk(startIso);
    const cal = calendarClient();
    const inserted = await cal.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${PENDING_PREFIX}${child} — ${subject}`,
        description:
          `Заявка через сайт записи (ожидает подтверждения).\n` +
          `Ученик: ${child}\n` +
          `Предмет: ${subject}\n` +
          `Родитель: ${parent.name}` +
          (parent.tg ? `\nTelegram: ${parent.tg}` : ""),
        start: { dateTime: startIso, timeZone: TIMEZONE },
        end: { dateTime: check.end.toISOString(), timeZone: TIMEZONE },
        status: "tentative",
        extendedProperties: {
          private: {
            app: "zapis",
            status: "pending",
            parentName: parent.name,
            parentTg: parent.tg,
            child,
            subject,
          },
        },
      },
    });

    const eventId = inserted.data.id;
    if (!eventId) throw new Error("Событие не создано");

    try {
      await notifyRequest({
        eventId,
        parentName: parent.name,
        parentTg: parent.tg,
        child,
        subject,
        when,
      });
    } catch (e) {
      // Заявка уже в календаре; сбой уведомления не должен ломать ответ родителю.
      console.error("Telegram notify failed", e);
    }

    return NextResponse.json({ ok: true, when });
  } catch (e: any) {
    console.error("/api/book error", e);
    return NextResponse.json({ error: "Не удалось создать заявку" }, { status: 500 });
  }
}
