import { NextResponse } from "next/server";
import { sendTodayReminders } from "@/lib/morning";

export const dynamic = "force-dynamic";

// Утренний крон (vercel.json, 09:00 МСК): напоминания ученикам о сегодняшних занятиях.
export async function GET(req: Request) {
  // Vercel Cron подписывает запросы заголовком Authorization: Bearer <CRON_SECRET>,
  // если секрет задан в env. Без секрета эндпоинт безвреден (шлёт напоминания).
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  try {
    const reminders = await sendTodayReminders(new Date());
    return NextResponse.json({ ok: true, reminders });
  } catch (e) {
    console.error("cron/morning error", e);
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
