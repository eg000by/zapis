import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient, fetchBusy } from "@/lib/google";
import { buildRecurrence, formatMsk, weeklyOccurrences, windowBounds } from "@/lib/slots";
import { decodeToken, contactKey } from "@/lib/link";
import { notifyRequest } from "@/lib/telegram";
import { PENDING_PREFIX, RECURRENCE_WEEKS, SLOT_MINUTES, SUBJECTS, TIMEZONE } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const decoded = decodeToken(body?.token);
  if (!decoded.ok) {
    const error =
      decoded.reason === "expired"
        ? "Ссылка истекла. Попросите преподавателя прислать новую персональную ссылку."
        : "Недействительная ссылка. Попросите преподавателя прислать персональную ссылку.";
    return NextResponse.json({ error }, { status: 403 });
  }
  const contact = decoded.info;

  const student = String(body?.student || "").trim();
  const subject = String(body?.subject || "").trim();

  // Принимаем и один слот (start), и несколько (starts).
  const rawStarts: string[] = Array.isArray(body?.starts)
    ? body.starts.map((s: any) => String(s))
    : body?.start
      ? [String(body.start)]
      : [];
  const starts = Array.from(new Set(rawStarts.filter(Boolean)));

  // Повтор — фиксированный горизонт (~полгода). Либо разовая запись.
  const repeat = Boolean(body?.repeat);
  const weeks = repeat ? RECURRENCE_WEEKS : 1;

  if (!student) return NextResponse.json({ error: "Укажите имя ученика" }, { status: 400 });
  if (!SUBJECTS.includes(subject)) {
    return NextResponse.json({ error: "Выберите предмет" }, { status: 400 });
  }
  if (starts.length === 0) {
    return NextResponse.json({ error: "Выберите хотя бы один слот" }, { status: 400 });
  }

  try {
    const now = new Date();
    const { timeMin, timeMax } = windowBounds(now);

    // Для повторяющихся записей проверяем занятость и за пределами окна —
    // до последнего занятия самой дальней серии.
    let far = timeMax.getTime();
    for (const s of starts) {
      const occ = weeklyOccurrences(s, weeks);
      const last = new Date(occ[occ.length - 1]).getTime() + SLOT_MINUTES * 60000;
      if (last > far) far = last;
    }
    const busy = await fetchBusy(timeMin, new Date(far + 60000));

    // Заранее считаем правила повторения (и проверяем первый слот каждой серии).
    const plans: { startIso: string; recurrence?: string[] }[] = [];
    for (const startIso of starts) {
      const r = buildRecurrence(startIso, weeks, busy, now);
      if (!r.ok) {
        return NextResponse.json(
          { error: `${formatMsk(startIso)}: ${r.reason || "слот недоступен"}` },
          { status: 409 }
        );
      }
      plans.push({ startIso, recurrence: r.recurrence });
    }

    const cal = calendarClient();
    const key = contactKey(contact);
    const created: { when: string }[] = [];

    for (const plan of plans) {
      const startIso = plan.startIso;
      const end = new Date(new Date(startIso).getTime() + SLOT_MINUTES * 60000);
      const suffix = repeat ? " (еженедельно, полгода)" : "";

      const inserted = await cal.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: `${PENDING_PREFIX}${student} — ${subject}`,
          description:
            `Заявка через сайт записи (ожидает подтверждения).\n` +
            `Ученик: ${student}\n` +
            `Предмет: ${subject}\n` +
            (repeat ? `Повтор: еженедельно, ~полгода\n` : "") +
            `Записал(а): ${contact.name}` +
            (contact.tg ? `\nTelegram: ${contact.tg}` : ""),
          start: { dateTime: startIso, timeZone: TIMEZONE },
          end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
          status: "tentative",
          ...(plan.recurrence ? { recurrence: plan.recurrence } : {}),
          extendedProperties: {
            private: {
              app: "zapis",
              status: "pending",
              contactKey: key,
              name: contact.name,
              tg: contact.tg,
              student,
              subject,
              weeks: String(weeks),
            },
          },
        },
      });

      const eventId = inserted.data.id;
      if (!eventId) throw new Error("Событие не создано");

      const when = `${formatMsk(startIso)}${suffix}`;
      created.push({ when });

      try {
        await notifyRequest({
          eventId,
          name: contact.name,
          tg: contact.tg,
          student,
          subject,
          when,
        });
      } catch (e) {
        // Заявка уже в календаре; сбой уведомления не должен ломать ответ пользователю.
        console.error("Telegram notify failed", e);
      }
    }

    const when =
      created.length === 1
        ? created[0].when
        : `${created.length} занятий:\n` + created.map((c) => `• ${c.when}`).join("\n");

    return NextResponse.json({ ok: true, count: created.length, when });
  } catch (e: any) {
    console.error("/api/book error", e);
    return NextResponse.json({ error: "Не удалось создать заявку" }, { status: 500 });
  }
}
