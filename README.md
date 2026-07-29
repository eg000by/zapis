# Zapis — tutoring bookings & CRM

[![tests](https://github.com/eg000by/zapis/actions/workflows/test.yml/badge.svg)](https://github.com/eg000by/zapis/actions/workflows/test.yml)

**English** · [Русский](#zapis--запись-на-занятия-и-crm)

A production service for a private tutor: students book weekly lessons through a personal
link, the teacher runs the whole business — confirmations, reschedules, payments,
balances, reminders — from a Telegram bot. Live on Vercel, used daily with real students
and real money.

## What it does

- **Booking grid** — an anonymized week (Mon–Sun) of 60-minute slots with 10-minute
  breaks and **per-weekday working hours**; a personal signed link per student
  (`/z/<code>`); recurring weekly series, multi-hour blocks, one-off trial lessons.
- **Teacher approves everything in Telegram** — every request/reschedule arrives as a
  message with inline ✅/❌ buttons. Declining a reschedule safely returns the series to
  its previous time (with a stale-revision guard against outdated notifications).
- **Full CRM in the same bot** — students list, per-student card, invoices, notes,
  archive; the `/admin` web page exposes the same service layer (feature parity by design).
- **Money** — hourly rate per student; a pure "balance walk" allocates paid hours over
  lessons chronologically and derives *debt*, *paid-until date* and *credit* from one
  computation. Auto-invoicing issues two separate invoices (debt + month ahead),
  reconciled idempotently on every cabinet visit. Online payments via YooKassa (SBP),
  with a webhook that never trusts the notification body — it re-fetches the payment
  status from the API.
- **Calendar as the schedule's source of truth** — bookings live in Google Calendar
  events (`RRULE`, `EXDATE`, exception instances, `extendedProperties`); Postgres only
  keeps the accounting (students, invoices, notes). Lessons are auto-colored by payment
  status: green/red/orange, gray = missed (not billed).
- **Service notifications for students** — an opt-in Telegram deep-link connects a
  student's chat; they get booking confirmations, invoices with payment links, payment
  receipts and same-day lesson reminders.
- **Post-lesson pulse** — right after a lesson ends the teacher gets a "how did it
  go?" prompt (held / missed / add a note); a daily morning cron sends students
  same-day reminders.

## Architecture

```
        student                      teacher
           │                            │
   Next.js (App Router, Vercel)   Telegram bot (webhook)
           │                            │
           └────────── service layer (lib/*) ──────────┐
                       │               │               │
             Google Calendar       Postgres         YooKassa
             (schedule truth:      (accounting:     (payments,
              RRULE, EXDATE,        students,        SBP links,
              colors, ext.props)    invoices)        webhook)
```

Key decisions:

- **Modular monolith.** One repo, one deploy, clear seams in `lib/*`. The site and the
  bot are thin adapters over the same service functions — no logic duplication.
- **No custom scheduler state.** Recurring bookings are single calendar events with
  `RRULE:FREQ=WEEKLY;COUNT=26`; cancelled weeks are instance deletions; one-off
  reschedules are exception instances. The app derives everything by expanding instances.
- **Money in integer kopecks**, fixed MSK timezone, monotonic revision counters for
  reschedule confirmations, idempotent payment webhook and auto-invoice reconciliation.

## Testing

225 Vitest tests run the **real route handlers and calendar logic** against an in-memory
fake of the Google Calendar API (`test/helpers/fake-google.ts`) that faithfully implements
recurrence expansion, `EXDATE`, exception instances and `extendedProperties` merge
semantics — so scenario tests cover booking → confirmation → reschedule → decline-revert
→ cancellation end to end, plus the balance model, auto-invoicing, payment webhook and
cron digests. On top of that, 25 hermetic Playwright e2e tests drive the real
booking UI in a browser with every `/api/*` call intercepted.

Two of those suites exist because the bugs that reached production lived *between*
correct functions, not inside them:

- `test/balance-invariants.test.ts` — property-based (fast-check): hundreds of random
  lesson/payment layouts must satisfy the laws of the balance model (no hour is lost or
  invented, debt is never negative, all-or-nothing blocks, more money never makes things
  worse).
- `test/lifecycle.test.ts` — one continuous "month in a student's life" over the real
  calendar, balance, auto-invoicing and colouring, with time moving forward: booking →
  advance invoice → payment → lesson → debt → settlement.

```bash
npm run test        # unit/scenario (Vitest)
npm run test:e2e    # browser e2e (Playwright)
```

## Backups

Schema lives in `drizzle/` migrations, so backups only carry **data**: every `public`
table is dumped to one gzipped JSON by the same driver the app uses — no `pg_dump`
version-matching, identical locally and in CI.

```bash
npm run db:backup                                   # → backups/zapis-YYYY-MM-DD.json.gz
npm run db:restore -- backups/zapis-2026-07-29.json.gz          # dry run
npm run db:restore -- backups/zapis-2026-07-29.json.gz --yes    # apply
```

Restore truncates and reloads in foreign-key order inside a single transaction, so a
failure halfway leaves the database untouched. Run `npm run db:migrate` first when
restoring into an empty database.

`.github/workflows/backup.yml` does the same weekly and uploads the dump as a GPG-encrypted
artifact (90-day retention). **This repository is public and so are its artifacts** — the
job refuses to run without a `BACKUP_PASSPHRASE` secret rather than publishing student
names and payment records in the clear. Decrypt with
`gpg --output backup.json.gz --decrypt <file>.gpg`.

## Stack

Next.js 14 (App Router) · TypeScript · Drizzle ORM + Postgres (Supabase) ·
Google Calendar API (OAuth) · Telegram Bot API · YooKassa · Vitest · Vercel (+ Cron)

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in the secrets (see below)
npm run dev
```

Required env: Google OAuth (`GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`, `CALENDAR_ID`),
`DATABASE_URL`, `LINK_SIGNING_SECRET`, `ADMIN_SECRET`, Telegram
(`TELEGRAM_BOT_TOKEN/CHAT_ID/WEBHOOK_SECRET`), optional YooKassa
(`YOOKASSA_SHOP_ID/SECRET_KEY`). Migrations: `npm run db:migrate`.

`CRON_SECRET` is **required in production**: `/api/cron/*` answers 503 without it rather
than running unauthenticated (`lib/cron-auth.ts`). Vercel Cron signs its own requests
with it automatically once it is set in the project env; GitHub Actions sends the same
bearer token from a repository secret of the same name.

## Docker

Self-hosting without Vercel — multi-stage image on Next.js standalone output, plus a
scheduler sidecar that replaces Vercel Cron / GitHub Actions (15-minute lesson pulse,
daily morning reminders):

```bash
docker compose up --build   # app on :3000 + cron sidecar; secrets from .env.local
```

Secrets are runtime-only (`env_file`) — the image contains none. The database stays
external (Supabase); run migrations from the host: `npm run db:migrate`.

---

# Zapis — запись на занятия и CRM

[English](#zapis--tutoring-bookings--crm) · **Русский**

Боевой сервис для репетитора: ученики записываются на еженедельные занятия по личной
ссылке, преподаватель ведёт всё — подтверждения, переносы, оплаты, балансы,
напоминания — из Telegram-бота. Работает на Vercel с реальными учениками и деньгами.

## Возможности

- **Сетка записи** — обезличенная неделя (Пн–Вс) из часовых слотов с перерывами и
  **рабочими окнами по каждому дню недели**; персональная подписанная ссылка
  (`/z/<code>`); еженедельные серии, блоки из нескольких часов, разовые пробные.
- **Все решения — в Telegram** — каждая заявка и перенос приходят сообщением с
  inline-кнопками ✅/❌. Отклонение переноса безопасно возвращает серию на прежнее
  время (rev-guard отсекает устаревшие уведомления).
- **CRM в том же боте** — список учеников, карточка, счета, заметки, архив; веб-админка
  `/admin` работает поверх того же сервисного слоя (паритет поверхностей).
- **Деньги** — ставка ₽/час; «балансовый проход» раскладывает оплаченные часы по
  занятиям хронологически, и из одного вычисления получаются долг, «оплачено до» и
  остаток. Автосчета: два отдельных счёта (долг + месяц вперёд), идемпотентная сверка
  при каждом входе в кабинет. Онлайн-оплата ЮKassa (СБП); вебхук не верит телу
  уведомления и перечитывает статус платежа из API.
- **Календарь — источник правды расписания** — брони живут в событиях Google Calendar
  (`RRULE`, `EXDATE`, инстансы-исключения, `extendedProperties`); Postgres хранит только
  учёт (ученики, счета, заметки). Занятия автоматически красятся по оплате:
  зелёный/красный/оранжевый, серый = пропуск (не тарифицируется).
- **Уведомления ученикам** — подключение по deep-link в Telegram: подтверждения записи,
  счета со ссылкой на оплату, подтверждения оплаты, напоминания в день занятия.
- **Пульс после занятия** — сразу после конца занятия преподавателю приходит «как
  прошло?» (прошло / пропуск / заметка); утренний крон шлёт ученикам напоминания о
  сегодняшних занятиях.

## Тесты

159 тестов Vitest гоняют **настоящие роуты и календарную логику** поверх in-memory фейка
Google Calendar API, который честно реализует развёртку повторов, `EXDATE`,
инстансы-исключения и merge-семантику `extendedProperties` — сценарии покрывают
бронь → подтверждение → перенос → возврат → отмену, балансовую модель, автосчета,
платёжный вебхук и кроны. Плюс 13 герметичных браузерных e2e на Playwright —
реальный UI записи с перехватом всех вызовов `/api/*`.

## Стек

Next.js 14 (App Router) · TypeScript · Drizzle ORM + Postgres (Supabase) ·
Google Calendar API (OAuth) · Telegram Bot API · ЮKassa · Vitest · Vercel (+ Cron)

## Docker

Самостоятельный хостинг без Vercel — многостадийный образ на standalone-сборке Next.js
плюс планировщик-сайдкар вместо Vercel Cron / GitHub Actions (пульс каждые 15 минут,
утренние напоминания раз в день):

```bash
docker compose up --build   # приложение на :3000 + крон; секреты из .env.local
```

Секретов в образе нет — только в рантайме (`env_file`). База остаётся внешней
(Supabase); миграции — с хоста: `npm run db:migrate`.
