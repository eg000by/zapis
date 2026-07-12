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
import { recolorStudent } from "@/lib/coloring";
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

  // Режим переноса: "all" — вся еженедельная серия (по умолчанию); "once" — только одно
  // занятие серии (ученик заболел на этой неделе): двигаем один инстанс-исключение, серия
  // остаётся на месте. occStart — исходное время того занятия, которое переносим.
  const mode = body?.mode === "once" ? "once" : "all";
  const occStartIso = String(body?.occStart || "");

  const weeks = Number(priv.weeks) || 1;
  const student = priv.student || "";
  const subject = priv.subject || "";

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

    // ── Разовый перенос одного занятия серии ──────────────────────────────────
    if (mode === "once") {
      // Находим конкретное занятие серии. Если eventId уже указывает на исключение-инстанс
      // (повторный перенос того же занятия) — двигаем его напрямую; иначе ищем наступление
      // мастер-серии по времени occStart.
      let inst = ev;
      if (!ev.recurringEventId) {
        if (!occStartIso) {
          return NextResponse.json({ error: "Не выбрано занятие для переноса" }, { status: 400 });
        }
        const w0 = new Date(occStartIso).getTime();
        const res2 = await cal.events.instances({
          calendarId: CALENDAR_ID,
          eventId,
          timeMin: new Date(w0 - 60000).toISOString(),
          timeMax: new Date(w0 + 60000).toISOString(),
          maxResults: 5,
        });
        // Ищем именно наступление серии на occStart: сверяем originalStartTime, чтобы не
        // зацепить другой (ранее перенесённый) инстанс, случайно стоящий на этом времени.
        const found = (res2.data.items || []).find((i) => {
          if (i.status === "cancelled" || !i.id) return false;
          if (i.extendedProperties?.private?.moved === "1") return false;
          const orig = i.originalStartTime?.dateTime || i.start?.dateTime;
          return !!orig && Math.abs(new Date(orig).getTime() - w0) < 60000;
        });
        if (!found) {
          return NextResponse.json(
            { error: "Это занятие не найдено (возможно, уже перенесено)." },
            { status: 404 }
          );
        }
        inst = found;
      }
      const instPriv = inst.extendedProperties?.private || {};
      // Исходное время до переноса: при повторном переносе сохраняем самое первое (чтобы
      // отклонение вернуло занятие на его настоящее место в серии).
      const origStart = instPriv.origStart || occStartIso || inst.start?.dateTime || "";
      const rev = (Number(instPriv.rev) || 0) + 1;

      const far = Math.max(
        timeMax.getTime(),
        new Date(startIso).getTime() + blockSpanMinutes(lessons) * 60000
      );
      // Исключаем из занятости ТОЛЬКО сам переносимый инстанс: остальные занятия серии
      // остаются занятыми, иначе разовый перенос мог бы лечь поверх занятия своей же серии.
      const busy = await fetchBusy(timeMin, new Date(far + 60000), inst.id!);
      const v = buildRecurrence(startIso, 1, busy, now, lessons);
      if (!v.ok) {
        return NextResponse.json(
          { error: `${formatMskRange(startIso, lessons)}: ${v.reason || "слот недоступен"}` },
          { status: 409 }
        );
      }

      const end = new Date(new Date(startIso).getTime() + blockSpanMinutes(lessons) * 60000);
      await cal.events.patch({
        calendarId: CALENDAR_ID,
        eventId: inst.id!,
        requestBody: {
          summary: `${PENDING_PREFIX}${student} — ${subject}`,
          status: "tentative",
          // Снимаем старый цвет: pending-занятие не участвует в покраске, и прежний
          // «оплаченный» цвет не должен висеть на новом времени до подтверждения.
          colorId: null,
          start: { dateTime: startIso, timeZone: TIMEZONE },
          end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
          extendedProperties: {
            private: {
              status: "pending",
              moved: "1",
              origStart,
              lessons: String(lessons),
              rev: String(rev),
            },
          },
        },
      });

      // Пересчёт цветов (best-effort): занятие выпало из подтверждённых — баланс оплат
      // перераспределяется на остальные до решения преподавателя.
      const sid = instPriv.studentId || priv.studentId;
      if (sid) {
        try {
          await recolorStudent(sid);
        } catch (e) {
          console.error("recolor after reschedule once failed", e);
        }
      }

      const when = `${formatMskRange(startIso, lessons)} (разовый перенос)`;
      try {
        await notifyRequest({
          eventId: inst.id!,
          name: student || contact.name,
          tg: contact.tg,
          subject,
          when,
          header: "🔄 <b>Перенос одного занятия</b> — нужно подтвердить",
          rev,
        });
      } catch (e) {
        console.error("Telegram notify (reschedule once) failed", e);
      }

      return NextResponse.json({ ok: true, when });
    }

    // ── Перенос всей еженедельной серии ───────────────────────────────────────
    // Ревизия переноса: растёт с каждым повторным переносом до подтверждения. Кнопка
    // подтверждения несёт эту ревизию, и старое уведомление при нажатии распознаётся
    // как устаревшее (иначе подтверждение старого слота применяло бы последний слот).
    const rev = (Number(priv.rev) || 0) + 1;

    // Прежнее время записи — чтобы отклонение переноса вернуло её на место, а не удалило.
    // Для подтверждённой записи это её текущее время; при повторном переносе до решения
    // сохраняем уже запомненное (возврат — к последнему утверждённому времени).
    const prevStart =
      (priv.status === "confirmed" ? evStart : priv.prevStart || evStart) || "";

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
          private: {
            ...priv,
            status: "pending",
            lessons: String(lessons),
            rev: String(rev),
            ...(prevStart ? { prevStart } : {}),
          },
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
