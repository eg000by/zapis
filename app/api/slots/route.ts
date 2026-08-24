import { NextResponse } from "next/server";
import { fetchBusy } from "@/lib/google";
import { buildWeek, weekWindowBounds, type WeekOptions } from "@/lib/slots";
import { AVAILABILITY_WEEKS, CALENDAR_MONTHS, MSK_OFFSET_MINUTES, TIMEZONE } from "@/lib/config";

export const dynamic = "force-dynamic";

// Дата в пределах горизонта календаря (сегодня … +CALENDAR_MONTHS месяцев по МСК).
// Всё, что за границами, отбрасываем и показываем ближайшую неделю: сетка на год
// вперёд бессмысленна (расписание столько не живёт), а запрос к календарю — дорог.
function withinHorizon(iso: string, now: Date): boolean {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return false;
  const msk = new Date(now.getTime() + MSK_OFFSET_MINUTES * 60000);
  const limit = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth() + CALENDAR_MONTHS, 1);
  // Начало текущей недели: дату из прошлого не берём, но «понедельник этой недели»
  // при выборе сегодняшнего дня — берём.
  const back = (msk.getUTCDay() + 6) % 7;
  const weekStart = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - back);
  const wall = t + MSK_OFFSET_MINUTES * 60000;
  return wall >= weekStart && wall < limit;
}

// Сетка слотов. По умолчанию — ближайшая неделя под еженедельную серию: слот должен
// быть свободен AVAILABILITY_WEEKS недель подряд, ведь время закрепляется за учеником
// надолго. Параметры меняют ровно две вещи — какую неделю показать и сколько
// наступлений проверять:
//
//   ?trial=1     — пробное занятие (разовая запись): проверяем один раз;
//   ?occ=<ISO>   — разовый перенос занятия серии: неделя этого занятия, один раз;
//   ?from=<ISO>  — «другая дата»: календарная неделя (Пн–Вс) выбранной даты.
//
// Двойной брони это не открывает: занятость выбранного времени всё равно
// перепроверяется на сервере при самой записи (/api/book, /api/reschedule).
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const now = new Date();

    const occ = params.get("occ") || "";
    const from = params.get("from") || "";
    const occIso = occ && !isNaN(new Date(occ).getTime()) ? occ : undefined;
    const fromIso = from && withinHorizon(from, now) ? from : undefined;

    const opts: WeekOptions = {
      weeks: occIso || params.get("trial") === "1" ? 1 : AVAILABILITY_WEEKS,
      ...(occIso ? { occIso } : {}),
      ...(fromIso ? { fromIso } : {}),
    };

    const { timeMin, timeMax } = weekWindowBounds(now, opts);
    const busy = await fetchBusy(timeMin, timeMax);
    const days = buildWeek(busy, now, opts);
    return NextResponse.json({ tz: TIMEZONE, days });
  } catch (e: any) {
    console.error("/api/slots error", e);
    return NextResponse.json(
      { error: "Не удалось загрузить расписание" },
      { status: 500 }
    );
  }
}
