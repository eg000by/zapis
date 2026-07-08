import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit (CLI) не подхватывает .env.local сам — загружаем явно.
config({ path: ".env.local" });

export default defineConfig({
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Миграции идут через session-режим пула (порт 5432), не транзакционный.
  dbCredentials: { url: process.env.DIRECT_URL! },
});
