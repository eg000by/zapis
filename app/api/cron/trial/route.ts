import { NextResponse } from "next/server";
import { listTrialPending, updateStudent } from "@/lib/students";
import { listContactOccurrences } from "@/lib/google";
import { escapeHtml, inlineKeyboard, sendOwner } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Ежедневный крон (vercel.json): пробные ученики, у которых пробное занятие уже
// прошло, — владельцу уходит вопрос «что дальше?» с кнопками «Полноценный ученик»
// (mkfull: — снимает флаг и шлёт регулярную ссылку) и «Удалить» (существующий
// delstu:-диалог с подтверждением). Уведомление одноразовое (trialNotifiedAt).
export async function GET(req: Request) {
  // Vercel Cron подписывает запросы заголовком Authorization: Bearer <CRON_SECRET>,
  // если секрет задан в env. Без секрета эндпоинт безвреден (шлёт сообщение владельцу).
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  try {
    const pending = await listTrialPending();
    const now = Date.now();
    let notified = 0;
    for (const s of pending) {
      try {
        // Прошедшее ПОДТВЕРЖДЁННОЕ занятие — пробное состоялось.
        const occ = await listContactOccurrences(s.contactKey);
        if (!occ.some((o) => o.start.getTime() < now)) continue;

        await sendOwner(
          `🎯 <b>Пробное занятие прошло</b>\n\n🧑‍🎓 ${escapeHtml(s.name)}\n📚 ${escapeHtml(
            s.subject
          )}${s.tg ? `\n✈️ ${escapeHtml(s.tg)}` : ""}\n\nПродолжаете заниматься?`,
          inlineKeyboard([
            [{ text: "✅ Полноценный ученик", data: `mkfull:${s.id}` }],
            [{ text: "🗑 Удалить ученика", data: `delstu:${s.id}` }],
          ])
        );
        await updateStudent(s.id, { trialNotifiedAt: new Date() });
        notified++;
      } catch (e) {
        console.error("cron/trial: student failed", s.id, e);
      }
    }
    return NextResponse.json({ ok: true, checked: pending.length, notified });
  } catch (e) {
    console.error("cron/trial error", e);
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
