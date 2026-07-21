import { NextResponse } from "next/server";
import { decodeToken, contactKey } from "@/lib/link";
import { getStudent, getStudentByContactKey } from "@/lib/students";
import { createPayment, outstandingPackage, updatePayment } from "@/lib/payments";
import { createYkPayment, yookassaConfigured } from "@/lib/yookassa";
import { getPayMethod, getSbpDetails } from "@/lib/settings";
import { detectExamTariff } from "@/lib/config";

export const dynamic = "force-dynamic";

// Оплата месячного пакета (8 занятий ОГЭ/ЕГЭ) из кабинета ученика. Создаёт (или
// переиспользует существующий неоплаченный) пакетный счёт и, при ЮKassa, ссылку на
// оплату; в режиме СБП возвращает реквизиты. Отметку «оплачено» ставит вебхук ЮKassa
// или преподаватель вручную — здесь только выставление счёта.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const decoded = decodeToken(url.searchParams.get("token"));
  if (!decoded.ok) {
    return NextResponse.json({ error: decoded.reason }, { status: 403 });
  }
  try {
    const key = contactKey(decoded.info);
    const student = decoded.info.studentId
      ? await getStudent(decoded.info.studentId)
      : await getStudentByContactKey(key);
    if (!student) {
      return NextResponse.json({ error: "Ученик не найден" }, { status: 404 });
    }
    const tariff = detectExamTariff(student.subject);
    if (!tariff) {
      return NextResponse.json({ error: "Пакет доступен только для ОГЭ/ЕГЭ" }, { status: 400 });
    }

    // Переиспользуем ранее выставленный неоплаченный пакет (идемпотентность: повторное
    // нажатие не плодит счета), иначе создаём новый.
    let invoice = await outstandingPackage(student.id);
    const note = `Пакет «Месяц» — ${tariff.packageLessons} занятий (${tariff.label})`;
    if (!invoice) {
      invoice = await createPayment({
        studentId: student.id,
        amountKopecks: tariff.packageKopecks,
        kind: "package",
        note,
      });
    } else if (invoice.amountKopecks !== tariff.packageKopecks) {
      // Цена пакета изменилась — обновляем сумму и сбрасываем устаревшую ссылку.
      await updatePayment(invoice.id, {
        amountKopecks: tariff.packageKopecks,
        note,
        payLink: "",
        providerPaymentId: "",
      });
      invoice = { ...invoice, amountKopecks: tariff.packageKopecks, payLink: "" };
    }

    const method = await getPayMethod().catch(() => "yookassa" as const);
    if (method === "sbp") {
      const sbp = await getSbpDetails().catch(() => "");
      return NextResponse.json({ ok: true, sbp, amountKopecks: tariff.packageKopecks });
    }

    // ЮKassa: отдаём существующую ссылку или создаём платёж.
    let payLink = invoice.payLink;
    if (!payLink && yookassaConfigured()) {
      const yk = await createYkPayment({
        ourPaymentId: invoice.id,
        amountKopecks: tariff.packageKopecks,
        description: `Пакет ${tariff.label} (${tariff.packageLessons} занятий): ${student.name}`,
      });
      if (yk.confirmationUrl) {
        await updatePayment(invoice.id, {
          payLink: yk.confirmationUrl,
          providerPaymentId: yk.id,
        });
        payLink = yk.confirmationUrl;
      }
    }
    if (!payLink) {
      return NextResponse.json({ error: "Не удалось создать ссылку на оплату" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, payLink, amountKopecks: tariff.packageKopecks });
  } catch (e) {
    console.error("/api/pay-package error", e);
    return NextResponse.json({ error: "Не удалось оформить пакет" }, { status: 500 });
  }
}
