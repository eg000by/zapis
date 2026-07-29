// Проверка, что крон-эндпоинт дёрнул свой планировщик, а не случайный прохожий.
//
// Раньше проверка была условной: `if (secret && ...)` — не задан CRON_SECRET, и оба
// крона открыты наружу. Секрета не оказалось ни в Vercel, ни в GitHub, так что защиты
// не было вовсе. Теперь в проде секрет обязателен: не задан — эндпоинт отвечает 503 и
// громко пишет в лог, а не притворяется защищённым.
//
// Vercel Cron сам подписывает свои запросы заголовком Authorization: Bearer <CRON_SECRET>,
// если переменная задана в окружении проекта, — отдельной настройки для /api/cron/morning
// не нужно. GitHub Actions передаёт тот же заголовок вручную (см. .github/workflows/pulse.yml).
import { NextResponse } from "next/server";

export function cronAuthError(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    // Локально и в тестах секрет не нужен — эндпоинты дёргаются руками.
    if (process.env.NODE_ENV !== "production") return null;
    console.error("CRON_SECRET не задан — крон-эндпоинт отключён, планировщик получит 503");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }

  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }
  return null;
}
