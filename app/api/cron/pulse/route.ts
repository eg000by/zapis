import { NextResponse } from "next/server";
import { sendFinishedLessonPrompts } from "@/lib/pulse";
import { sendUpcomingLessonAlerts } from "@/lib/upcoming";
import { cronAuthError } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// Пульс-крон (~каждые 15 минут, GitHub Actions → сюда). Два дела на одном прогоне:
// занятия, которые вот-вот начнутся («скоро занятие» — обеим сторонам), и занятия,
// которые закончились и по которым вопрос ещё не задан («Как прошло?» владельцу).
export async function GET(req: Request) {
  const denied = cronAuthError(req);
  if (denied) return denied;

  try {
    const now = new Date();
    // Напоминание о предстоящем — best-effort: его сбой не должен мешать опросу
    // о прошедших занятиях (и наоборот, дальше по коду, — они независимы).
    const upcoming = await sendUpcomingLessonAlerts(now).catch((e) => {
      console.error("cron/pulse upcoming failed", e);
      return { sent: 0 };
    });
    const result = await sendFinishedLessonPrompts(now);
    return NextResponse.json({ ok: true, ...result, upcoming: upcoming.sent });
  } catch (e) {
    console.error("cron/pulse error", e);
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
