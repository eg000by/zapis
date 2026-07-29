import { NextResponse } from "next/server";
import { sendTodayReminders } from "@/lib/morning";
import { sendRenewalPrompts } from "@/lib/renew";
import { cronAuthError } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// Утренний крон (vercel.json, 09:00 МСК): напоминания ученикам о сегодняшних занятиях
// и вопрос владельцу о продлении серий, которые скоро закончатся.
export async function GET(req: Request) {
  const denied = cronAuthError(req);
  if (denied) return denied;

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
