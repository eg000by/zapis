import { NextResponse } from "next/server";
import { fetchBusy } from "@/lib/google";
import { buildWeek, weekWindowBounds, type WeekOptions } from "@/lib/slots";
import { AVAILABILITY_WEEKS, TIMEZONE } from "@/lib/config";

export const dynamic = "force-dynamic";

// Сетка слотов. По умолчанию — под еженедельную серию: слот должен быть свободен
// AVAILABILITY_WEEKS недель подряд, ведь время закрепляется за учеником надолго.
// Два случая, когда занимается ровно один час, и это правило только мешало:
//
//   ?trial=1     — пробное занятие (разовая запись);
//   ?occ=<ISO>   — разовый перенос одного занятия серии: сетка строится на неделю
//                  этого занятия, и занятость проверяется только на его дату.
//
// Раньше сетка была одна на всех: свободный час выглядел занятым из-за чужой серии,
// которая начинается со следующей недели, — и перенести занятие было некуда.
// Двойной брони это не открывает: занятость выбранного времени всё равно
// перепроверяется на сервере при самой записи (/api/book, /api/reschedule).
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const occ = params.get("occ") || "";
    const occIso = occ && !isNaN(new Date(occ).getTime()) ? occ : undefined;
    const opts: WeekOptions = occIso
      ? { occIso }
      : { weeks: params.get("trial") === "1" ? 1 : AVAILABILITY_WEEKS };

    const now = new Date();
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
