import { NextResponse } from "next/server";
import { fetchBusy } from "@/lib/google";
import { buildWeek, weekWindowBounds } from "@/lib/slots";
import { AVAILABILITY_WEEKS, TIMEZONE } from "@/lib/config";

export const dynamic = "force-dynamic";

// Сетка слотов. ?trial=1 — запись разовая (пробное занятие): слот проверяется
// только на ближайшее наступление, а не на AVAILABILITY_WEEKS недель вперёд.
// Иначе свободный на этой неделе час выглядел бы занятым из-за чужой серии,
// которая начинается со следующей недели, — и записаться было бы некуда.
// Двойной брони это не открывает: занятость выбранного времени всё равно
// перепроверяется на сервере при самой записи (/api/book → buildRecurrence).
export async function GET(req: Request) {
  try {
    const trial = new URL(req.url).searchParams.get("trial") === "1";
    const weeks = trial ? 1 : AVAILABILITY_WEEKS;
    const now = new Date();
    const { timeMin, timeMax } = weekWindowBounds(now, weeks);
    const busy = await fetchBusy(timeMin, timeMax);
    const days = buildWeek(busy, now, weeks);
    return NextResponse.json({ tz: TIMEZONE, days });
  } catch (e: any) {
    console.error("/api/slots error", e);
    return NextResponse.json(
      { error: "Не удалось загрузить расписание" },
      { status: 500 }
    );
  }
}
