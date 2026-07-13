import { defineConfig } from "@playwright/test";

// Герметичные e2e клиентского UI: реальный Next-сервер рендерит страницы, а все
// запросы браузера к /api/* перехватываются в тестах (page.route) — календарь, БД,
// Telegram и ЮKassa не трогаются. Секрет подписи ссылок нужен и серверу (декодирует
// токен на странице), и тестам (кодируют его) — задаём один на оба процесса.
process.env.LINK_SIGNING_SECRET = process.env.LINK_SIGNING_SECRET || "e2e-link-secret";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3100",
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
  },
  webServer: {
    command: "npx next dev -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: { ...process.env, LINK_SIGNING_SECRET: process.env.LINK_SIGNING_SECRET } as Record<
      string,
      string
    >,
  },
});
