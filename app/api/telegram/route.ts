import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient } from "@/lib/google";
import { formatMskRange } from "@/lib/slots";
import { answerCallback, editMessageText } from "@/lib/telegram";
import { setLessonStatusByEvent } from "@/lib/lessons";
import { recolorEvent } from "@/lib/coloring";
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

  // Пользователь мог отменить заявку сам — тогда событие уже удалено и приходит
  // со статусом "cancelled". Не воскрешаем его при подтверждении.
  if (ev.status === "cancelled") {
    await answerCallback(cq.id, "Заявку отменил сам пользователь");
    if (chatId && messageId) {
      await editMessageText(
        chatId,
        messageId,
        "🚫 <b>Пользователь отменил эту заявку</b> — подтверждать нечего."
      );
    }
    return NextResponse.json({ ok: true });
  }

  const priv = ev.extendedProperties?.private || {};
  const student = priv.student || priv.name || "";
  const subject = priv.subject || "";
  const tg = priv.tg || "";
  const lessons =
    Number(priv.lessons) ||
    (ev.start?.dateTime && ev.end?.dateTime
      ? Math.max(
          1,
          Math.round(
            (new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime()) / 3600000
          )
        )
      : 1);
  const when = ev.start?.dateTime ? formatMskRange(ev.start.dateTime, lessons) : "";
  const cleanSummary = (ev.summary || `${student} — ${subject}`).replace(PENDING_PREFIX, "");

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
      try {
        await setLessonStatusByEvent(eventId, "confirmed");
        // Подтверждённое, но неоплаченное занятие красим красным (Фаза 3).
        await recolorEvent(eventId);
      } catch (e) {
        console.error("CRM lesson status/color (confirm) failed", e);
      }
      await answerCallback(cq.id, "Запись подтверждена ✅");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          `✅ <b>Запись подтверждена</b>\n\n🧑‍🎓 ${student}\n📚 ${subject}\n🕒 ${when}${tg ? `\n✈️ ${tg}` : ""}`
        );
      }
    } else if (action === "d") {
      // Отклоняем: удаляем событие, слот освобождается.
      await cal.events.delete({ calendarId: CALENDAR_ID, eventId });
      try {
        await setLessonStatusByEvent(eventId, "cancelled");
      } catch (e) {
        console.error("CRM lesson status (decline) failed", e);
      }
      await answerCallback(cq.id, "Заявка отклонена ❌");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          `❌ <b>Заявка отклонена</b>\n\n🧑‍🎓 ${student}\n📚 ${subject}\n🕒 ${when}${tg ? `\n✈️ ${tg}` : ""}`
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
