// Разовый скрипт для получения Google OAuth refresh-token.
// Запуск: node scripts/get-refresh-token.mjs
// Redirect URI OAuth-клиента: http://localhost:53682/oauth2callback

import http from "node:http";
import { readFileSync } from "node:fs";
import { google } from "googleapis";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

function loadEnvLocal() {
  const out = {};
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* .env.local может отсутствовать — возьмём из process.env */
  }
  return out;
}

const env = { ...loadEnvLocal(), ...process.env };
const clientId = env.GOOGLE_CLIENT_ID;
const clientSecret = env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "\n❌ Не найдены GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.\n" +
      "   Впишите их в .env.local и запустите снова.\n"
  );
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline", // чтобы выдался refresh_token
  prompt: "consent", // всегда просить согласие → refresh_token придёт даже при повторе
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith("/oauth2callback")) {
    res.writeHead(404).end();
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h2>Отказано в доступе: ${err}</h2>`);
    console.error("\n❌ Доступ отклонён:", err, "\n");
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (tokens.refresh_token) {
      res.end(
        "<h2>Готово! ✅</h2><p>Refresh-token получен. Вернитесь в терминал и скопируйте его в .env.local. Это окно можно закрыть.</p>"
      );
      console.log("\n✅ Успешно! Вставьте это в .env.local:\n");
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    } else {
      res.end(
        "<h2>Токен обновления не пришёл</h2><p>Отзовите доступ приложению на https://myaccount.google.com/permissions и запустите скрипт заново.</p>"
      );
      console.error(
        "\n⚠️ refresh_token не пришёл (доступ уже был выдан ранее).\n" +
          "   Откройте https://myaccount.google.com/permissions, удалите приложение и запустите скрипт снова.\n"
      );
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>Ошибка обмена кода на токен</h2>");
    console.error("\n❌ Ошибка:", e?.message || e, "\n");
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 300);
  }
});

server.listen(PORT, () => {
  console.log("\n1) Откройте эту ссылку в браузере и авторизуйтесь:\n");
  console.log("   " + authUrl + "\n");
  console.log(`2) Жду ответ на ${REDIRECT_URI} ...\n`);
});
