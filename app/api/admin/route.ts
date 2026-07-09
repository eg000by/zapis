import { NextResponse } from "next/server";
import { updateStudent } from "@/lib/students";
import { setLessonNote } from "@/lib/lessons";
import {
  createPayment,
  deletePayment,
  lessonIdsForPayment,
  setPayLink,
  setPaymentStatus,
} from "@/lib/payments";
import { recolorLesson, recolorPaymentLessons } from "@/lib/coloring";

export const dynamic = "force-dynamic";

// Перекраска событий — best-effort: сбой цвета в календаре не должен ломать
// сохранение оплаты (иначе внешний try вернул бы 500).
async function recolorSafe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("recolor failed", e);
  }
}

// Правки CRM с сайта /admin (заметки, ставка, активность). Закрыто ADMIN_SECRET.
// Обёртка над тем же сервисным слоем lib/*, что и будущий Telegram-бот (паритет).
export async function POST(req: Request) {
  const form = await req.formData();
  const key = String(form.get("key") || "");
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || key !== adminSecret) {
    return NextResponse.json({ error: "Доступ закрыт" }, { status: 403 });
  }

  const action = String(form.get("action") || "");
  const studentId = String(form.get("studentId") || "");

  try {
    if (action === "student.note") {
      await updateStudent(studentId, { note: String(form.get("note") || "") });
    } else if (action === "student.rate") {
      const rub = Math.max(0, Math.round(Number(form.get("rate") || 0)));
      await updateStudent(studentId, { rateKopecks: rub * 100 });
    } else if (action === "student.active") {
      await updateStudent(studentId, { active: String(form.get("active")) === "1" });
    } else if (action === "lesson.note") {
      await setLessonNote(String(form.get("lessonId") || ""), String(form.get("note") || ""));
    } else if (action === "payment.create") {
      const rub = Math.max(0, Math.round(Number(form.get("amount") || 0)));
      const lessonIds = form.getAll("lessonId").map((v) => String(v)).filter(Boolean);
      await createPayment({
        studentId,
        amountKopecks: rub * 100,
        note: String(form.get("note") || ""),
        payLink: String(form.get("payLink") || "").trim(),
        lessonIds,
      });
    } else if (action === "payment.paid") {
      const pid = String(form.get("paymentId") || "");
      await setPaymentStatus(pid, "paid");
      await recolorSafe(() => recolorPaymentLessons(pid)); // покрытые занятия → зелёный
    } else if (action === "payment.unpaid") {
      const pid = String(form.get("paymentId") || "");
      await setPaymentStatus(pid, "unpaid");
      await recolorSafe(() => recolorPaymentLessons(pid)); // красный, если подтверждено
    } else if (action === "payment.link") {
      await setPayLink(
        String(form.get("paymentId") || ""),
        String(form.get("payLink") || "").trim()
      );
    } else if (action === "payment.delete") {
      const pid = String(form.get("paymentId") || "");
      // Занятия платежа фиксируем до удаления (связи уйдут каскадом), потом красим заново.
      const affected = await lessonIdsForPayment(pid);
      await deletePayment(pid);
      await recolorSafe(async () => {
        for (const lid of affected) await recolorLesson(lid);
      });
    } else {
      return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
    }
  } catch (e) {
    console.error("/api/admin error", e);
    return NextResponse.json({ error: "Не удалось сохранить" }, { status: 500 });
  }

  const back = new URL("/admin", req.url);
  back.searchParams.set("key", key);
  if (studentId) {
    back.searchParams.set("view", "student");
    back.searchParams.set("id", studentId);
  }
  return NextResponse.redirect(back, { status: 303 });
}
