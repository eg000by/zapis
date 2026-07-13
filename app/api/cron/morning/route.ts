import { NextResponse } from "next/server";
import { notifyTrialsPassed, sendTodayReminders, sendYesterdayReport } from "@/lib/morning";

export const dynamic = "force-dynamic";

// Единый утренний крон (vercel.json, 09:00 МСК): на бесплатном тарифе Vercel кронов
// всего два, поэтому все утренние задачи собраны в один эндпоинт. Каждая задача
// изолирована: сбой одной не срывает остальные.
export async function GET(req: Request) {
  // Vercel Cron подписывает запросы заголовком Authorization: Bearer <CRON_SECRET>,
  // если секрет задан в env. Без секрета эндпоинт безвреден (шлёт сообщения владельцу).
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  const now = new Date();
  const run = async <T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await fn();
    } catch (e) {
      console.error(`cron/morning ${name} failed`, e);
      return { error: name };
    }
  };

  const [trial, report, reminders] = await Promise.all([
    run("trial", () => notifyTrialsPassed(now)),
    run("report", () => sendYesterdayReport(now)),
    run("reminders", () => sendTodayReminders(now)),
  ]);
  return NextResponse.json({ ok: true, trial, report, reminders });
}
