import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient } from "@/lib/google";
import { formatMsk } from "@/lib/slots";
import { answerCallback, editMessageText } from "@/lib/telegram";
import { PENDING_PREFIX } from "@/lib/config";

export const dynamic = "force-dynamic";

// Webhook Telegram: обрабатывает нажатия кнопок Подтвердить/Отклонить.
export async function POST(req: Request) {
  // Защита webhook секретным токеном (задаётся при setWebhook).
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== expected) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const cq = update?.callback_query;
  if (!cq) return NextResponse.json({ ok: true });

  const data: string = cq.data || "";
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  // Только владелец бота (заданный chat_id) может подтверждать.
  const ownerChat = process.env.TELEGRAM_CHAT_ID;
  if (ownerChat && String(chatId) !== String(ownerChat)) {
    await answerCallback(cq.id, "Нет доступа");
    return NextResponse.json({ ok: true });
  }

  const [action, eventId] = splitAction(data);
  if (!action || !eventId) {
    await answerCallback(cq.id, "Неизвестная команда");
    return NextResponse.json({ ok: true });
  }

  const cal = calendarClient();

  // Читаем событие. Если его нет — заявку уже обработали/удалили.
  let ev;
  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId });
    ev = res.data;
  } catch {
    await answerCallback(cq.id, "Заявка не найдена (возможно, уже обработана)");
    if (chatId && messageId) {
      await editMessageText(chatId, messageId, "⚠️ Заявка не найдена (возможно, уже обработана).");
    }
    return NextResponse.json({ ok: true });
  }

  const priv = ev.extendedProperties?.private || {};
  const child = priv.child || "";
  const subject = priv.subject || "";
  const parentName = priv.parentName || "";
  const parentTg = priv.parentTg || "";
  const when = ev.start?.dateTime ? formatMsk(ev.start.dateTime) : "";
  const cleanSummary = (ev.summary || `${child} — ${subject}`).replace(PENDING_PREFIX, "");

  try {
    if (action === "c") {
      // Подтверждаем: убираем пометку, статус confirmed.
      await cal.events.patch({
        calendarId: CALENDAR_ID,
        eventId,
        requestBody: {
          summary: cleanSummary,
          status: "confirmed",
          extendedProperties: { private: { status: "confirmed" } },
        },
      });
      await answerCallback(cq.id, "Запись подтверждена ✅");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          `✅ <b>Запись подтверждена</b>\n\n🧒 ${child}\n📚 ${subject}\n🕒 ${when}\n👤 ${parentName}${parentTg ? ` (${parentTg})` : ""}`
        );
      }
    } else if (action === "d") {
      // Отклоняем: удаляем событие, слот освобождается.
      await cal.events.delete({ calendarId: CALENDAR_ID, eventId });
      await answerCallback(cq.id, "Заявка отклонена ❌");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          `❌ <b>Заявка отклонена</b>\n\n🧒 ${child}\n📚 ${subject}\n🕒 ${when}\n👤 ${parentName}${parentTg ? ` (${parentTg})` : ""}`
        );
      }
    }
  } catch (e) {
    console.error("telegram action error", e);
    await answerCallback(cq.id, "Ошибка при обработке");
  }

  return NextResponse.json({ ok: true });
}

function splitAction(data: string): [string | null, string | null] {
  const idx = data.indexOf(":");
  if (idx < 0) return [null, null];
  return [data.slice(0, idx), data.slice(idx + 1)];
}
