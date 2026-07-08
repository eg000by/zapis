import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient, fetchBusy, listContactEvents } from "@/lib/google";
import { buildRecurrence, formatMskRange, weeklyOccurrences, windowBounds } from "@/lib/slots";
import { groupConsecutive } from "@/lib/blocks";
import { decodeToken, contactKey } from "@/lib/link";
import { notifyRequest } from "@/lib/telegram";
import {
  MAX_LESSONS_PER_WEEK,
  PENDING_PREFIX,
  RECURRENCE_WEEKS,
  SLOT_MINUTES,
  SUBJECTS,
  TIMEZONE,
} from "@/lib/config";

// Индекс недели момента (7-дневные корзины). Еженедельное повторение сдвигает
// момент ровно на 7 суток, поэтому каждое занятие серии попадает в свою корзину.
const WEEK_MS = 7 * 86400000;
function weekKey(ms: number): number {
  return Math.floor(ms / WEEK_MS);
}

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

  // Имя и предмет зашиты в ссылку — пользователь на сайте ничего о себе не вводит.
  const student = contact.name.trim();
  const subject = contact.subject.trim();

  // Принимаем и один слот (start), и несколько (starts).
  const rawStarts: string[] = Array.isArray(body?.starts)
    ? body.starts.map((s: any) => String(s))
    : body?.start
      ? [String(body.start)]
      : [];
  const starts = Array.from(new Set(rawStarts.filter(Boolean)));

  // Пробное — разовая запись; иначе еженедельный повтор на полгода вперёд.
  const weeks = contact.trial ? 1 : RECURRENCE_WEEKS;

  if (!student) return NextResponse.json({ error: "Некорректная ссылка" }, { status: 400 });
  if (!SUBJECTS.includes(subject)) {
    return NextResponse.json({ error: "Некорректная ссылка: предмет" }, { status: 400 });
  }
  if (starts.length === 0) {
    return NextResponse.json({ error: "Выберите хотя бы один слот" }, { status: 400 });
  }

  // Подряд идущие часы объединяем в один блок (одно событие в календаре).
  const blocks = groupConsecutive(starts);

  try {
    const now = new Date();
    const { timeMin, timeMax } = windowBounds(now);

    // Для повторяющихся записей проверяем занятость и за пределами окна —
    // до последнего занятия самой дальней серии.
    let far = timeMax.getTime();
    for (const b of blocks) {
      const hours = b.slots.length;
      const occ = weeklyOccurrences(b.start, weeks);
      const last = new Date(occ[occ.length - 1]).getTime() + hours * SLOT_MINUTES * 60000;
      if (last > far) far = last;
    }
    const busy = await fetchBusy(timeMin, new Date(far + 60000));

    const cal = calendarClient();
    const key = contactKey(contact);

    // Лимит: не больше MAX_LESSONS_PER_WEEK часов на одного человека в неделю.
    // Считаем текущую загрузку по неделям (существующие записи этого человека).
    const load = new Map<number, number>();
    const addLoad = (wk: number, h: number) => load.set(wk, (load.get(wk) || 0) + h);
    try {
      const mine = await listContactEvents(key, now.toISOString());
      for (const e of mine) {
        const w0 = weekKey(new Date(e.start).getTime());
        const span = e.recurring ? Math.max(1, e.weeks) : 1;
        for (let i = 0; i < span; i++) addLoad(w0 + i, e.hours);
      }
    } catch (e) {
      console.error("weekly-load lookup failed", e);
    }

    // Заранее считаем правила повторения (и проверяем первый слот каждой серии),
    // а также сверяем недельный лимит с учётом уже добавляемых блоков.
    const plans: { startIso: string; hours: number; recurrence?: string[] }[] = [];
    for (const b of blocks) {
      const hours = b.slots.length;
      const w0 = weekKey(new Date(b.start).getTime());
      const span = weeks > 1 ? weeks : 1;
      for (let i = 0; i < span; i++) {
        if ((load.get(w0 + i) || 0) + hours > MAX_LESSONS_PER_WEEK) {
          return NextResponse.json(
            {
              error: `На неделю можно записать не больше ${MAX_LESSONS_PER_WEEK} занятий на человека. Отмените лишнее в разделе «Ваши записи» или выберите меньше времени.`,
            },
            { status: 409 }
          );
        }
      }

      const r = buildRecurrence(b.start, weeks, busy, now, hours);
      if (!r.ok) {
        return NextResponse.json(
          { error: `${formatMskRange(b.start, hours)}: ${r.reason || "слот недоступен"}` },
          { status: 409 }
        );
      }
      plans.push({ startIso: b.start, hours, recurrence: r.recurrence });
      // Учитываем этот блок в загрузке, чтобы несколько блоков считались вместе.
      for (let i = 0; i < span; i++) addLoad(w0 + i, hours);
    }

    const created: { when: string }[] = [];

    for (const plan of plans) {
      const startIso = plan.startIso;
      const hours = plan.hours;
      const end = new Date(new Date(startIso).getTime() + hours * SLOT_MINUTES * 60000);
      const suffix = plan.recurrence ? " (еженедельно)" : "";

      const inserted = await cal.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: `${PENDING_PREFIX}${student} — ${subject}`,
          description:
            `Заявка через сайт записи (ожидает подтверждения).\n` +
            `Ученик: ${student}\n` +
            `Предмет: ${subject}\n` +
            (plan.recurrence ? `Повтор: еженедельно\n` : `Пробное занятие (разовое)\n`) +
            (contact.tg ? `Telegram: ${contact.tg}\n` : ""),
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

      const when = `${formatMskRange(startIso, hours)}${suffix}`;
      created.push({ when });

      try {
        await notifyRequest({
          eventId,
          name: student,
          tg: contact.tg,
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
