import { NextResponse } from "next/server";
import { decodeToken, contactKey } from "@/lib/link";
import { getStudent, getStudentByContactKey } from "@/lib/students";
import { getGroup } from "@/lib/groups";
import { pingSent, recordPing } from "@/lib/pings";
import { escapeHtml, sendOwner } from "@/lib/telegram";
import { formatMsk } from "@/lib/slots";

export const dynamic = "force-dynamic";

// «Не смогу прийти» из кабинета участника группы. Ничего не двигает и не отменяет:
// занятие общее, решение — за преподавателем. Задача кнопки в том, чтобы ученик не
// искал способ предупредить и не пропадал молча.
//
// Дедупликация через lesson_pings (префикс skip:): повторные нажатия по тому же
// занятию не превращаются в поток сообщений.
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const decoded = decodeToken(body?.token);
  if (!decoded.ok) {
    return NextResponse.json({ error: "Недействительная ссылка" }, { status: 403 });
  }
  const startIso = String(body?.start || "");
  const start = new Date(startIso);
  if (!startIso || isNaN(start.getTime())) {
    return NextResponse.json({ error: "Не выбрано занятие" }, { status: 400 });
  }

  try {
    const student = decoded.info.studentId
      ? await getStudent(decoded.info.studentId)
      : await getStudentByContactKey(contactKey(decoded.info));
    if (!student) return NextResponse.json({ error: "Ученик не найден" }, { status: 404 });

    const key = `skip:${student.id}:${start.toISOString()}`;
    if (await pingSent(key)) return NextResponse.json({ ok: true, already: true });

    const group = student.groupId ? await getGroup(student.groupId) : null;
    await sendOwner(
      `🙈 <b>Не сможет прийти</b>\n\n` +
        `🧑‍🎓 ${escapeHtml(student.name)}${group ? ` · группа «${escapeHtml(group.name)}»` : ""}\n` +
        `🕒 ${escapeHtml(formatMsk(start.toISOString()))}\n\n` +
        `Занятие в календаре не изменилось — решение за вами.`
    );
    await recordPing(key);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("/api/absence error", e);
    return NextResponse.json({ error: "Не удалось отправить" }, { status: 500 });
  }
}
