import { NextResponse } from "next/server";
import { decodeToken, contactKey } from "@/lib/link";
import { listContactEvents } from "@/lib/google";

export const dynamic = "force-dynamic";

// Список записей владельца ссылки.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const decoded = decodeToken(url.searchParams.get("token"));
  if (!decoded.ok) {
    return NextResponse.json({ error: decoded.reason }, { status: 403 });
  }
  try {
    const key = contactKey(decoded.info);
    const events = await listContactEvents(key, new Date().toISOString());
    return NextResponse.json({ events });
  } catch (e) {
    console.error("/api/my error", e);
    return NextResponse.json({ error: "Не удалось загрузить записи" }, { status: 500 });
  }
}
