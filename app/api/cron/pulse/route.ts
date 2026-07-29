import { NextResponse } from "next/server";
import { sendFinishedLessonPrompts } from "@/lib/pulse";
import { cronAuthError } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// Пульс-крон (~каждые 15 минут, GitHub Actions → сюда): занятия, закончившиеся к
// этому моменту, по которым вопрос ещё не задан, — владельцу «Как прошло?» с кнопками.
export async function GET(req: Request) {
  const denied = cronAuthError(req);
  if (denied) return denied;

  try {
    const result = await sendFinishedLessonPrompts(new Date());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("cron/pulse error", e);
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
