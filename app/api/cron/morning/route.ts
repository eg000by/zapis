import { NextResponse } from "next/server";
import { sendRenewalPrompts } from "@/lib/renew";
import { cronAuthError } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// Утренний крон (vercel.json, 09:00 МСК): вопрос владельцу о сериях, которые скоро
// закончатся. Напоминания ученикам сюда больше не входят — они зависят от времени
// самого занятия (вечер накануне либо утро того же дня) и живут в пульсе,
// см. lib/reminders.ts.
export async function GET(req: Request) {
  const denied = cronAuthError(req);
  if (denied) return denied;

  try {
    const renew = await sendRenewalPrompts(new Date());
    return NextResponse.json({ ok: true, renew });
  } catch (e) {
    console.error("cron/morning error", e);
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
