import { NextResponse } from "next/server";
import { decodeToken, contactKey } from "@/lib/link";
import { listContactEvents } from "@/lib/google";
import { getStudentByContactKey } from "@/lib/students";
import { outstandingPayments } from "@/lib/payments";

export const dynamic = "force-dynamic";

// Список записей владельца ссылки + его неоплаченные счета (для кнопки «Оплатить»).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const decoded = decodeToken(url.searchParams.get("token"));
  if (!decoded.ok) {
    return NextResponse.json({ error: decoded.reason }, { status: 403 });
  }
  try {
    const key = contactKey(decoded.info);
    const events = await listContactEvents(key, new Date().toISOString());

    // Счета к оплате — best-effort: недоступность БД не должна ломать список записей.
    let payments: { id: string; amountKopecks: number; note: string; payLink: string }[] = [];
    try {
      const student = decoded.info.studentId
        ? null
        : await getStudentByContactKey(key);
      const studentId = decoded.info.studentId || student?.id;
      if (studentId) {
        const rows = await outstandingPayments(studentId);
        payments = rows.map((p) => ({
          id: p.id,
          amountKopecks: p.amountKopecks,
          note: p.note,
          payLink: p.payLink,
        }));
      }
    } catch (e) {
      console.error("/api/my payments lookup failed", e);
    }

    return NextResponse.json({ events, payments });
  } catch (e) {
    console.error("/api/my error", e);
    return NextResponse.json({ error: "Не удалось загрузить записи" }, { status: 500 });
  }
}
