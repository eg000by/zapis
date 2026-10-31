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
  A date picker jumps the grid to any calendar week three months out, and each
  booking kind is checked for exactly what it occupies: a weekly series needs the
  hour free four weeks running, a trial or a single-lesson reschedule only once.
- **Teacher approves everything in Telegram** — every request/reschedule arrives as a
  message with inline ✅/❌ buttons. Declining a reschedule safely returns the series to
  its previous time (with a stale-revision guard against outdated notifications).
- **Group lessons** — up to four students share one calendar event, but money and
  cabinets stay personal: the group carries its own price per student, its own meeting
  link and its own schedule, which only the teacher sets. A member's cabinet has no
  booking grid at all (the slot belongs to four people) — it turns into a panel: the
  next lesson with its meeting link, the schedule spelled out as actual dates with
  paid/unpaid per lesson, the payment card, the roster, and a "can't make it" button
  on each date that pings the teacher without touching the calendar. Members are
  enrolled from inside the group — the wizard asks for a name and nothing else, since
  the subject and the price already belong to the group. Group lessons are deliberately
  left uncoloured: one colour cannot tell the truth about four different balances.
  After the lesson the bot asks *who showed up* instead of "how did it go" — attendance
  is per student, so a missed lesson drops out of that student's billing while the
  shared event stays untouched.
- **Full CRM in the same bot** — students list, per-student card, invoices, notes,
  archive; the `/admin` web page exposes the same service layer (feature parity by design).
  The everyday flows are cut to a tap or two: a **trial lesson** is one button that
  produces a ready-to-copy list of free windows for the parent, and one line
  ("Masha OGE @tg") that creates the student and a confirmed lesson, re-checking the slot
  against a fresh calendar first; **debts** list every debtor with a one-tap "✅ Paid"
  and an undo for a mis-tap; **income** shows only money actually received plus a
  forecast for the month (group lessons counted per member, trials excluded).
- **Money** — hourly rate per student; a pure "balance walk" allocates paid hours over
  lessons chronologically and derives *debt*, *paid-until date* and *credit* from one
  computation. Auto-invoicing issues two separate invoices (debt + the single next
  lesson), reconciled idempotently on every cabinet visit. Online payments via YooKassa (SBP),
  with a webhook that never trusts the notification body — it re-fetches the payment
  status from the API.
- **Calendar as the schedule's source of truth** — bookings live in Google Calendar
  events (`RRULE`, `EXDATE`, exception instances, `extendedProperties`); Postgres only
  keeps the accounting (students, invoices, notes). Lessons are auto-colored by payment
  status: green/red/orange, gray = missed (not billed).
- **Service notifications for students** — an opt-in Telegram deep-link connects a
  student's chat; they get booking confirmations, lesson reminders and an "upcoming
  lesson" alert with the meeting link. Money is deliberately excluded — invoices live
  in the cabinet, and a payment message is the fastest way to make someone mute the
  bot. `/stop` disconnects; the CRM command menu is scoped to the owner's chat only.
  A blocked bot (403 / "chat not found") unlinks the chat so the cabinet offers to
  reconnect, and "can't make it" silences that student's reminders for the date.
- **Post-lesson pulse** — right after a lesson ends the teacher gets a "how did it
  go?" prompt (held / missed / add a note). Reminders are timed to the lesson itself:
  a morning lesson is announced at 19:00 the previous evening, anything later at 10:00
  on the day.

## Product decisions

Features are kept or removed by how they are used, not by how good they sounded:

- **Discounted exam packages and "pay a month ahead" were removed.** Over three and a
  half months the system made 21 such offers and got 0 payments — students pay per
  lesson, right after it. The discount would only have gone to exam students who stay
  anyway, and missed lessons couldn't be deducted from a package. The removal shipped
  with a migration that deletes the stale unpaid offers (checked against production
  first: none had a payment link or a payment), and the YooKassa webhook now warns the
  teacher if money ever arrives for an invoice that no longer exists.
- **No money in student notifications** (see above): reminders are only useful if
  nobody mutes them.

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
- **Two schedulers, one message.** Free Vercel cron runs once a day and GitHub throttles
  cron in public repos to once every 2–3 hours, so the frequent pulse is driven by an
  external pinger with a self-pacing GitHub Actions loop as backup. They can fire at
  the same moment, so every reminder goes through `sendOnce` (`lib/once.ts`): a
  short lease separates concurrent runs, and the "sent" mark is written *after* the
  send — a run killed mid-send loses its lease and the next run retries. A rare
  duplicate is preferred over a lost reminder.

## Testing

441 Vitest tests run the **real route handlers and calendar logic** against an in-memory
fake of the Google Calendar API (`test/helpers/fake-google.ts`) that faithfully implements
recurrence expansion, `EXDATE`, exception instances and `extendedProperties` merge
semantics — so scenario tests cover booking → confirmation → reschedule → decline-revert
→ cancellation end to end, plus the balance model, auto-invoicing, payment webhook and
cron digests. On top of that, 33 hermetic Playwright e2e tests drive the real
booking UI in a browser with every `/api/*` call intercepted.

Three of those suites exist because the bugs that reached production lived *between*
correct functions, not inside them:

- `test/balance-invariants.test.ts` — property-based (fast-check): hundreds of random
  lesson/payment layouts must satisfy the laws of the balance model (no hour is lost or
  invented, debt is never negative, all-or-nothing blocks, more money never makes things
  worse).
- `test/lifecycle.test.ts` — one continuous "month in a student's life" over the real
  calendar, balance, auto-invoicing and colouring, with time moving forward: booking →
  advance invoice → payment → lesson → debt → settlement.
- `test/group-bot.test.ts` — platform limits are not suggestions. A button carrying two
  uuids exceeded Telegram's 64-byte `callback_data` cap, and the API refuses the whole
  message rather than truncating it: the screen simply never opened, and the only trace
  was a line in the logs. The suite renders the group screens with real uuids and
  asserts that every button fits.

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
scheduler sidecar that replaces Vercel Cron / GitHub Actions (frequent lesson pulse —
reminders and «upcoming lesson» alerts — plus the daily series-renewal check):

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
  Календарь «другая дата» переводит сетку на любую неделю на три месяца вперёд, а
  занятость проверяется ровно по тому, что запись займёт: еженедельной серии нужен
  свободный час четыре недели подряд, пробному и разовому переносу — один раз.
- **Все решения — в Telegram** — каждая заявка и перенос приходят сообщением с
  inline-кнопками ✅/❌. Отклонение переноса безопасно возвращает серию на прежнее
  время (rev-guard отсекает устаревшие уведомления).
- **Групповые занятия** — до четырёх учеников на одном событии календаря, но деньги
  и кабинет у каждого свои: у группы своя цена за занятие с человека, своя ссылка на
  Телемост и своё расписание, которое ставит только преподаватель. Сетки записи у
  участника нет вовсе (время общее на четверых) — кабинет становится панелью:
  ближайшее занятие со ссылкой, расписание конкретными датами и пометкой «оплачено»
  у каждой, оплата, состав группы и кнопка «не смогу прийти» у каждой даты — она
  предупреждает преподавателя и ничего не двигает. Ученик заводится прямо из группы:
  мастер спрашивает только имя, потому что предмет и цена — уже её. Групповые занятия
  намеренно не красятся: один цвет не может быть правдой сразу для четырёх балансов.
  После занятия бот спрашивает не «как прошло», а «кто был»: пропуск персональный —
  занятие выпадает из тарификации только у того, кого не было, а общее событие
  остаётся нетронутым.
- **CRM в том же боте** — список учеников, карточка, счета, заметки, архив; веб-админка
  `/admin` работает поверх того же сервисного слоя (паритет поверхностей).
  Частые действия — в один-два тапа: **пробное** — одна кнопка даёт готовый текст со
  свободными окнами для родителя, а одна строка («Маша ОГЭ @tg») заводит ученика и
  подтверждённое занятие, перед этим перепроверив слот по свежему календарю;
  **долги** — каждый должник с кнопкой «✅ Оплатил» и отменой промаха; **доходы** —
  только реально полученное и прогноз на месяц (группы — по участникам, пробные не в счёт).
- **Деньги** — ставка ₽/час; «балансовый проход» раскладывает оплаченные часы по
  занятиям хронологически, и из одного вычисления получаются долг, «оплачено до» и
  остаток. Автосчета: два отдельных счёта (долг + одно ближайшее занятие),
  идемпотентная сверка при каждом входе в кабинет. Онлайн-оплата ЮKassa (СБП); вебхук не верит телу
  уведомления и перечитывает статус платежа из API.
- **Календарь — источник правды расписания** — брони живут в событиях Google Calendar
  (`RRULE`, `EXDATE`, инстансы-исключения, `extendedProperties`); Postgres хранит только
  учёт (ученики, счета, заметки). Занятия автоматически красятся по оплате:
  зелёный/красный/оранжевый, серый = пропуск (не тарифицируется).
- **Уведомления ученикам** — подключение по deep-link в Telegram: подтверждения записи,
  напоминание о занятии и «скоро занятие» со ссылкой на Телемост. Денег в них нет
  намеренно: счета живут в кабинете, а сообщение про оплату — быстрый способ добиться,
  чтобы человек отключил уведомления вместе с напоминаниями. Отписка — /stop, меню
  команд CRM видно только в чате владельца. Если бот заблокирован (403 / «chat not
  found»), чат отвязывается и кабинет снова предлагает подключиться; «Не смогу
  прийти» глушит напоминания этому ученику на эту дату.
- **Пульс после занятия** — сразу после конца занятия преподавателю приходит «как
  прошло?» (прошло / пропуск / заметка). Момент напоминания зависит от времени самого
  занятия: утреннее (до 12:00) — накануне в 19:00, остальные — в 10:00 того же дня.

## Продуктовые решения

Функции остаются или уходят по тому, как ими пользуются:

- **Пакеты со скидкой и «оплата месяца вперёд» удалены.** За три с половиной месяца —
  21 предложение и 0 оплат: ученики платят поштучно сразу после занятия. Скидка
  доставалась бы экзаменационным, которые и так не уходят, а пропуски с пакета не
  списывались. Вместе с удалением — миграция, снимающая висящие предложения (сначала
  проверено на проде: ни ссылок, ни оплат), а вебхук ЮKassa теперь предупреждает, если
  деньги придут по уже удалённому счёту.
- **В уведомлениях ученикам нет денег** (см. выше): напоминания полезны, только пока их
  не отключили.

## Надёжность уведомлений

Бесплатный Vercel даёт крон раз в день, а GitHub душит кроны публичных репозиториев до
раза в 2–3 часа, поэтому частый пульс дёргает внешний пингер, а цикл в GitHub Actions
его подстраховывает. Они могут сработать одновременно, поэтому каждое напоминание идёт
через `sendOnce` (`lib/once.ts`): одновременные прогоны разводит короткая аренда, а
отметка «отправлено» ставится *после* отправки — прогон, убитый посреди send, теряет
аренду, и следующий повторит. Редкий дубль лучше потерянного напоминания.

## Тесты

441 тест Vitest гоняет **настоящие роуты и календарную логику** поверх in-memory фейка
Google Calendar API, который честно реализует развёртку повторов, `EXDATE`,
инстансы-исключения и merge-семантику `extendedProperties` — сценарии покрывают
бронь → подтверждение → перенос → возврат → отмену, балансовую модель, автосчета,
платёжный вебхук и кроны. Плюс 33 герметичных браузерных e2e на Playwright —
реальный UI записи с перехватом всех вызовов `/api/*`.

## Стек

Next.js 14 (App Router) · TypeScript · Drizzle ORM + Postgres (Supabase) ·
Google Calendar API (OAuth) · Telegram Bot API · ЮKassa · Vitest · Vercel (+ Cron)

## Docker

Самостоятельный хостинг без Vercel — многостадийный образ на standalone-сборке Next.js
плюс планировщик-сайдкар вместо Vercel Cron / GitHub Actions (пульс каждые 15 минут,
утренний прогон раз в день):

```bash
docker compose up --build   # приложение на :3000 + крон; секреты из .env.local
```

Секретов в образе нет — только в рантайме (`env_file`). База остаётся внешней
(Supabase); миграции — с хоста: `npm run db:migrate`.
