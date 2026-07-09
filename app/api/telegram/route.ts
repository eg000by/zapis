import { NextResponse } from "next/server";
import { CALENDAR_ID, calendarClient } from "@/lib/google";
import { formatMskRange } from "@/lib/slots";
import { answerCallback, editMessageText, sendOwner } from "@/lib/telegram";
import { setLessonStatusByEvent } from "@/lib/lessons";
import { recolorEvent } from "@/lib/coloring";
import {
  applyPendingInput,
  markPaymentPaid,
  promptLessonNote,
  promptNewPayment,
  promptPaymentLink,
  promptStudentNote,
  showLessons,
  showPayments,
  showStudentCard,
  showStudentsList,
} from "@/lib/crm-bot";
import { PENDING_PREFIX } from "@/lib/config";

export const dynamic = "force-dynamic";

const ok = () => NextResponse.json({ ok: true });

function isOwner(chatId: unknown): boolean {
  const owner = process.env.TELEGRAM_CHAT_ID;
  return !owner || String(chatId) === String(owner);
}

// Webhook Telegram: подтверждение/отклонение заявок + управление CRM (Фаза 4).
export async function POST(req: Request) {
  // Защита webhook секретным токеном (задаётся при setWebhook).
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected && req.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return ok();
  }

  try {
    if (update?.callback_query) return await handleCallback(update.callback_query);
    if (update?.message) return await handleMessage(update.message);
  } catch (e) {
    console.error("telegram handler error", e);
  }
  return ok();
}

async function handleCallback(cq: any): Promise<NextResponse> {
  const data: string = cq.data || "";
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  if (!isOwner(chatId)) {
    await answerCallback(cq.id, "Нет доступа");
    return ok();
  }

  // Навигация CRM.
  if (data === "stus") {
    await showStudentsList(chatId, messageId);
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("stu:")) {
    await showStudentCard(chatId, messageId, data.slice(4));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("pays:")) {
    await showPayments(chatId, messageId, data.slice(5));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("les:")) {
    await showLessons(chatId, messageId, data.slice(4));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("payp:")) {
    const sid = await markPaymentPaid(data.slice(5));
    await answerCallback(cq.id, "Оплата отмечена ✅");
    if (sid) await showPayments(chatId, messageId, sid);
    return ok();
  }
  if (data.startsWith("newp:")) {
    await promptNewPayment(chatId, data.slice(5));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("plink:")) {
    await promptPaymentLink(chatId, data.slice(6));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("snote:")) {
    await promptStudentNote(chatId, data.slice(6));
    await answerCallback(cq.id);
    return ok();
  }
  if (data.startsWith("lnote:")) {
    await promptLessonNote(chatId, data.slice(6));
    await answerCallback(cq.id);
    return ok();
  }

  // Подтверждение/отклонение заявки (c:/d:).
  const [action, eventId] = splitAction(data);
  if ((action === "c" || action === "d") && eventId) {
    return await handleBookingAction(cq, action, eventId, chatId, messageId);
  }

  await answerCallback(cq.id, "Неизвестная команда");
  return ok();
}

async function handleMessage(msg: any): Promise<NextResponse> {
  const chatId = msg.chat?.id;
  if (!isOwner(chatId)) return ok();
  const text = String(msg.text || "").trim();
  if (!text) return ok();

  if (text === "/start" || text.startsWith("/students")) {
    await showStudentsList(chatId, null);
    return ok();
  }

  // Бот ждёт ввод (текст заметки)?
  if (await applyPendingInput(chatId, text)) return ok();

  if (text.startsWith("/")) {
    await sendOwner("Команды:\n/students — ученики, оплаты и заметки");
  }
  return ok();
}

// Подтверждение/отклонение заявки (существующая логика).
async function handleBookingAction(
  cq: any,
  action: "c" | "d",
  eventId: string,
  chatId: any,
  messageId: number | undefined
): Promise<NextResponse> {
  const cal = calendarClient();

  let ev;
  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId });
    ev = res.data;
  } catch {
    await answerCallback(cq.id, "Заявка не найдена (возможно, уже обработана)");
    if (chatId && messageId) {
      await editMessageText(chatId, messageId, "⚠️ Заявка не найдена (возможно, уже обработана).");
    }
    return ok();
  }

  // Пользователь мог отменить заявку сам — событие приходит со статусом "cancelled".
  if (ev.status === "cancelled") {
    await answerCallback(cq.id, "Заявку отменил сам пользователь");
    if (chatId && messageId) {
      await editMessageText(
        chatId,
        messageId,
        "🚫 <b>Пользователь отменил эту заявку</b> — подтверждать нечего."
      );
    }
    return ok();
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
    } else {
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

  return ok();
}

function splitAction(data: string): [string | null, string | null] {
  const idx = data.indexOf(":");
  if (idx < 0) return [null, null];
  return [data.slice(0, idx), data.slice(idx + 1)];
}
