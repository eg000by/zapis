import { NextResponse } from "next/server";
import { sendTodayReminders } from "@/lib/morning";
import { sendRenewalPrompts } from "@/lib/renew";

export const dynamic = "force-dynamic";

// Утренний крон (vercel.json, 09:00 МСК): напоминания ученикам о сегодняшних занятиях
// и вопрос владельцу о продлении серий, которые скоро закончатся.
export async function GET(req: Request) {
  // Vercel Cron подписывает запросы заголовком Authorization: Bearer <CRON_SECRET>,
  // если секрет задан в env. Без секрета эндпоинт безвреден (шлёт напоминания).
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  try {
    const now = new Date();
    const reminders = await sendTodayReminders(now);
    // Продление серий — best-effort: сбой календаря не должен ронять напоминания.
    const renew = await sendRenewalPrompts(now).catch((e) => {
      console.error("cron/morning renewal failed", e);
      return { asked: 0 };
    });
    return NextResponse.json({ ok: true, reminders, renew });
  } catch (e) {
    console.error("cron/morning error", e);
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
