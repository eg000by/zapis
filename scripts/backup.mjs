// Резервная копия БД: все таблицы public → один gzip-JSON.
//
// Почему не pg_dump: сервер Supabase — Postgres 17, а pg_dump обязан быть не старше
// сервера; на macOS и на раннере это разные версии, и бэкап начинает падать в самый
// неподходящий момент. Схема и так версионируется миграциями в drizzle/, поэтому
// копия нужна только на ДАННЫЕ — а их прекрасно читает тот же драйвер, что и само
// приложение. Ноль внешних зависимостей, одинаково работает локально и в CI.
//
// Запуск: npm run db:backup  (пишет в backups/, папка в .gitignore)
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const DUMP_VERSION = 1;

// trim: строка подключения часто приезжает из буфера обмена с переводом строки.
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("Нет DATABASE_URL (локально — в .env.local, в CI — в секретах репозитория)");
  process.exit(1);
}

// Таблицы служебные (миграции drizzle) в копию не идут: их восстанавливает npm run db:migrate.
const SKIP = /^(__|drizzle)/;

// Локальная база (проверка восстановления) поднимается без TLS — Supabase без него не пускает.
const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);
const sql = postgres(url, { ssl: isLocal ? false : "require", max: 1, idle_timeout: 5 });

try {
  const tables = (
    await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`
  )
    .map((r) => r.table_name)
    .filter((t) => !SKIP.test(t));

  if (tables.length === 0) throw new Error("В схеме public нет таблиц — копировать нечего");

  const dump = { version: DUMP_VERSION, createdAt: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    dump.tables[t] = await sql`select * from ${sql(t)}`;
    console.log(`  ${t}: ${dump.tables[t].length}`);
  }

  const total = Object.values(dump.tables).reduce((s, rows) => s + rows.length, 0);
  // Пустая БД — почти наверняка не «нечего сохранять», а неверный DATABASE_URL.
  // Молча переписать этим хорошую копию хуже, чем упасть.
  if (total === 0) throw new Error("Во всех таблицах 0 строк — похоже, база не та");

  const dir = process.env.BACKUP_DIR || "backups";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `zapis-${new Date().toISOString().slice(0, 10)}.json.gz`);
  const gz = gzipSync(Buffer.from(JSON.stringify(dump)), { level: 9 });
  writeFileSync(file, gz);

  console.log(`\n${file} — ${tables.length} таблиц, ${total} строк, ${(gz.length / 1024).toFixed(1)} КБ`);
} catch (e) {
  console.error("Бэкап не сделан:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
