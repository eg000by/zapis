// Восстановление БД из копии, сделанной scripts/backup.mjs.
//
// ОПАСНО: очищает таблицы и заливает содержимое копии. Без --yes только показывает,
// что бы сделал. Схему восстанавливать не умеет — сперва npm run db:migrate, потом это.
//
// Запуск: npm run db:restore -- backups/zapis-2026-07-29.json.gz --yes
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const file = process.argv[2];
const confirmed = process.argv.includes("--yes");
if (!file) {
  console.error("Укажите файл копии: npm run db:restore -- backups/zapis-ГГГГ-ММ-ДД.json.gz --yes");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Нет DATABASE_URL");
  process.exit(1);
}

const dump = JSON.parse(gunzipSync(readFileSync(file)).toString());
const names = Object.keys(dump.tables);

console.log(`Копия от ${dump.createdAt}`);
console.log(`База-получатель: ${new URL(url).hostname}\n`);

const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);
const sql = postgres(url, { ssl: isLocal ? false : "require", max: 1, idle_timeout: 5 });

try {
  // Порядок заливки — по внешним ключам: родители раньше детей. Иначе вставка
  // упадёт на FK (у drizzle они не DEFERRABLE, отложить нельзя).
  const fks = await sql`
    select con.conrelid::regclass::text as child, con.confrelid::regclass::text as parent
    from pg_constraint con
    where con.contype = 'f' and con.conrelid <> con.confrelid`;
  const parentsOf = new Map(names.map((n) => [n, new Set()]));
  for (const { child, parent } of fks) {
    if (parentsOf.has(child) && parentsOf.has(parent)) parentsOf.get(child).add(parent);
  }
  const order = [];
  const placed = new Set();
  while (order.length < names.length) {
    const next = names.filter(
      (n) => !placed.has(n) && [...parentsOf.get(n)].every((p) => placed.has(p))
    );
    // Цикл во внешних ключах — раскладывать нечем, льём как есть.
    if (next.length === 0) {
      order.push(...names.filter((n) => !placed.has(n)));
      break;
    }
    for (const n of next) {
      order.push(n);
      placed.add(n);
    }
  }

  for (const t of order) console.log(`  ${t}: ${dump.tables[t].length} строк`);

  if (!confirmed) {
    console.log("\nЭто пробный прогон. Чтобы применить, добавьте --yes");
    process.exit(0);
  }

  // Всё одной транзакцией: упало на полпути — база осталась как была.
  await sql.begin(async (tx) => {
    for (const t of [...order].reverse()) await tx`delete from ${tx(t)}`;
    for (const t of order) {
      const rows = dump.tables[t];
      if (rows.length === 0) continue;
      // Пачками — чтобы не упереться в лимит параметров запроса.
      for (let i = 0; i < rows.length; i += 500) {
        await tx`insert into ${tx(t)} ${tx(rows.slice(i, i + 500))}`;
      }
    }
  });

  console.log("\nГотово: база приведена к состоянию копии.");
} catch (e) {
  console.error("Восстановление не выполнено:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
