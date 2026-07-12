import { NextResponse } from "next/server";
import { decodeToken, contactKey } from "@/lib/link";
import { listContactEvents, nextOccurrenceForContact } from "@/lib/google";
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

    // Три независимых источника — параллельно (два запроса к календарю + БД);
    // nextLesson и payments — best-effort: их сбой не ломает список записей.
    const [events, nextLesson, payments] = await Promise.all([
      listContactEvents(key, new Date().toISOString()),
      // Ближайшее занятие (конкретная дата) — с учётом отмен и переносов.
      nextOccurrenceForContact(key).catch((e) => {
        console.error("/api/my nextLesson lookup failed", e);
        return null;
      }),
      // Счета к оплате.
      (async () => {
        try {
          const student = decoded.info.studentId
            ? null
            : await getStudentByContactKey(key);
          const studentId = decoded.info.studentId || student?.id;
          if (!studentId) return [];
          const rows = await outstandingPayments(studentId);
          return rows.map((p) => ({
            id: p.id,
            amountKopecks: p.amountKopecks,
            note: p.note,
            payLink: p.payLink,
          }));
        } catch (e) {
          console.error("/api/my payments lookup failed", e);
          return [] as { id: string; amountKopecks: number; note: string; payLink: string }[];
        }
      })(),
    ]);

    return NextResponse.json({ events, payments, nextLesson });
  } catch (e) {
    console.error("/api/my error", e);
    return NextResponse.json({ error: "Не удалось загрузить записи" }, { status: 500 });
  }
}
