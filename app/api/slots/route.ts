import { NextResponse } from "next/server";
import { fetchBusy } from "@/lib/google";
import { buildWeek, weekWindowBounds } from "@/lib/slots";
import { TIMEZONE } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const now = new Date();
    const { timeMin, timeMax } = weekWindowBounds(now);
    const busy = await fetchBusy(timeMin, timeMax);
    const days = buildWeek(busy, now);
    return NextResponse.json({ tz: TIMEZONE, days });
  } catch (e: any) {
    console.error("/api/slots error", e);
    return NextResponse.json(
      { error: "Не удалось загрузить расписание" },
      { status: 500 }
    );
  }
}
