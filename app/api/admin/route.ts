import { NextResponse } from "next/server";
import { deleteStudent, updateStudent } from "@/lib/students";
import { setLessonNote } from "@/lib/lessons";
import {
  createPayment,
  deletePayment,
  setPayLink,
  setPaymentStatus,
} from "@/lib/payments";
import { recolorStudent } from "@/lib/coloring";

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
      await recolorSafe(() => recolorStudent(studentId)); // ставка меняет число оплаченных
    } else if (action === "student.active") {
      await updateStudent(studentId, { active: String(form.get("active")) === "1" });
    } else if (action === "student.delete") {
      // Необратимо: каскадом уходят занятия, оплаты и ссылки ученика. После —
      // редирект в общий список (карточки уже нет), см. ветку ниже.
      await deleteStudent(studentId);
    } else if (action === "lesson.note") {
      await setLessonNote(String(form.get("lessonId") || ""), String(form.get("note") || ""));
    } else if (action === "payment.create") {
      const rub = Math.max(0, Math.round(Number(form.get("amount") || 0)));
      await createPayment({
        studentId,
        amountKopecks: rub * 100,
        note: String(form.get("note") || ""),
        payLink: String(form.get("payLink") || "").trim(),
      });
    } else if (action === "payment.paid") {
      await setPaymentStatus(String(form.get("paymentId") || ""), "paid");
      await recolorSafe(() => recolorStudent(studentId)); // пересчёт баланса → цвета
    } else if (action === "payment.unpaid") {
      await setPaymentStatus(String(form.get("paymentId") || ""), "unpaid");
      await recolorSafe(() => recolorStudent(studentId));
    } else if (action === "payment.link") {
      await setPayLink(
        String(form.get("paymentId") || ""),
        String(form.get("payLink") || "").trim()
      );
    } else if (action === "payment.delete") {
      await deletePayment(String(form.get("paymentId") || ""));
      await recolorSafe(() => recolorStudent(studentId)); // меньше баланс → пересчёт цветов
    } else {
      return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
    }
  } catch (e) {
    console.error("/api/admin error", e);
    return NextResponse.json({ error: "Не удалось сохранить" }, { status: 500 });
  }

  const back = new URL("/admin", req.url);
  back.searchParams.set("key", key);
  // После удаления ученика карточки уже нет — возвращаемся в общий список.
  if (studentId && action !== "student.delete") {
    back.searchParams.set("view", "student");
    back.searchParams.set("id", studentId);
  }
  return NextResponse.redirect(back, { status: 303 });
}
