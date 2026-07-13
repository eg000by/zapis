import { NextResponse } from "next/server";
import { getYkPayment, yookassaConfigured } from "@/lib/yookassa";
import { getPayment, getPaymentByProviderId, setPaymentStatus, updatePayment } from "@/lib/payments";
import { getStudent } from "@/lib/students";
import { recolorStudent } from "@/lib/coloring";
import { escapeHtml, sendOwner } from "@/lib/telegram";
import { notifyStudent } from "@/lib/notify";

export const dynamic = "force-dynamic";

// Вебхук ЮKassa (payment.succeeded / payment.canceled). Телу уведомления НЕ верим —
// его может прислать кто угодно: берём из него только id платежа и перечитываем
// статус из API ЮKassa (запрос под нашим секретным ключом). Идемпотентен: повтор
// уведомления об уже оплаченном счёте ничего не меняет.
export async function POST(req: Request) {
  const ok = NextResponse.json({ ok: true });
  if (!yookassaConfigured()) return ok;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return ok;
  }
  const ykId = String(body?.object?.id || "");
  if (!ykId) return ok;

  let yk;
  try {
    yk = await getYkPayment(ykId); // доверенный источник статуса
  } catch (e) {
    console.error("webhook: yookassa fetch failed", e);
    // 500 → ЮKassa повторит уведомление позже.
    return NextResponse.json({ error: "retry" }, { status: 500 });
  }

  // Наш счёт: по metadata.paymentId (кладём при создании) или по id платежа.
  const our =
    (yk.metadata.paymentId ? await getPayment(yk.metadata.paymentId) : null) ||
    (await getPaymentByProviderId(yk.id));
  if (!our) return ok; // не наш платёж

  try {
    if (yk.status === "succeeded") {
      if (our.status === "paid") return ok; // уже учтено
      if (yk.amountKopecks !== our.amountKopecks) {
        // Сумма платежа не сошлась со счётом (счёт успели пересчитать) — не засчитываем
        // автоматически, пусть решает преподаватель.
        console.error("webhook: amount mismatch", { payment: our.id, yk: yk.amountKopecks, our: our.amountKopecks });
        await sendOwner(
          `⚠️ <b>Оплата не сошлась со счётом</b>\n\nПоступило ${(yk.amountKopecks / 100).toLocaleString("ru-RU")} ₽, а счёт на ${(our.amountKopecks / 100).toLocaleString("ru-RU")} ₽.\nОтметьте оплату вручную в /admin.`
        ).catch(() => {});
        return ok;
      }
      await setPaymentStatus(our.id, "paid");
      try {
        await recolorStudent(our.studentId);
      } catch (e) {
        console.error("webhook: recolor failed", e);
      }
      try {
        const s = await getStudent(our.studentId);
        await sendOwner(
          `💰 <b>Оплата получена</b>\n\n🧑‍🎓 ${escapeHtml(s?.name || "")}\n💳 ${(our.amountKopecks / 100).toLocaleString("ru-RU")} ₽${our.note ? `\n📝 ${escapeHtml(our.note)}` : ""}`
        );
        await notifyStudent(
          s,
          `✅ Оплата получена: <b>${(our.amountKopecks / 100).toLocaleString("ru-RU")} ₽</b>. Спасибо!`
        );
      } catch (e) {
        console.error("webhook: notify failed", e);
      }
    } else if (yk.status === "canceled") {
      // Платёж истёк/отменён — ссылка мертва. Чистим её, чтобы следующий заход в
      // кабинет сгенерировал свежую.
      if (our.status === "unpaid" && our.providerPaymentId === yk.id) {
        await updatePayment(our.id, { payLink: "", providerPaymentId: "" });
      }
    }
  } catch (e) {
    console.error("webhook: processing failed", e);
    return NextResponse.json({ error: "retry" }, { status: 500 });
  }
  return ok;
}
