// Подключение к Postgres (Supabase) через postgres-js + Drizzle.
// Синглтон, как calendarClient() в lib/google.ts. В dev/serverless кешируем
// клиента в globalThis, чтобы HMR и переиспользование инстансов не плодили
// соединения к пулу.
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __pgClient: ReturnType<typeof postgres> | undefined;
}

function client(): ReturnType<typeof postgres> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL не задан");
  // prepare:false обязателен для транзакционного пула Supabase (порт 6543).
  if (!global.__pgClient) global.__pgClient = postgres(url, { prepare: false });
  return global.__pgClient;
}

let cached: PostgresJsDatabase<typeof schema> | null = null;

export function db(): PostgresJsDatabase<typeof schema> {
  if (!cached) cached = drizzle(client(), { schema });
  return cached;
}
