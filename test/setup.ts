// Общий сетап тестов: фиктивные секреты, чтобы модули не падали на проверке env.
// Реальные значения не нужны — Google API замокан, Telegram-транспорт замокан.
process.env.LINK_SIGNING_SECRET = "test-link-secret";
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_REFRESH_TOKEN = "test-refresh-token";
process.env.CALENDAR_ID = "test-calendar";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
process.env.TELEGRAM_CHAT_ID = "111222333";
