// Схема БД (Drizzle). Единый источник схемы — миграции в папке drizzle/.
// Postgres — система учёта (ученики, занятия, позже оплаты). Календарь остаётся
// источником правды для расписания; связь — через contactKey и calendar_event_id.
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const students = pgTable("students", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  tg: text("tg").notNull().default(""),
  subject: text("subject").notNull(),
  // Стабильный ключ сопоставления с событиями календаря (HMAC имени+предмета+tg, lib/link.ts).
  contactKey: text("contact_key").notNull().unique(),
  // Ставка за час в копейках (для расчёта оплат).
  rateKopecks: integer("rate_kopecks").notNull().default(0),
  active: boolean("active").notNull().default(true),
  note: text("note").notNull().default(""), // общая заметка/профиль ученика
  // Пробный ученик: записан по пробной ссылке, ещё не подтверждён как постоянный.
  // Флаг снимается кнопкой «Полноценный ученик» в боте или созданием регулярной ссылки.
  trial: boolean("trial").notNull().default(false),
  // Когда владельцу отправлен вопрос «пробное прошло — что дальше?» (чтобы не повторять).
  trialNotifiedAt: timestamp("trial_notified_at", { withTimezone: true }),
  // Постоянная ссылка на онлайн-занятие (Яндекс Телемост) — показывается в кабинете.
  meetLink: text("meet_link").notNull().default(""),
  // chat_id ученика в Telegram — для сервисных уведомлений. Заполняется, когда ученик
  // сам открывает бота по deep-link из кабинета (бот не может написать первым).
  tgChatId: text("tg_chat_id").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const lessons = pgTable("lessons", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id")
    .notNull()
    .references(() => students.id, { onDelete: "cascade" }),
  calendarEventId: text("calendar_event_id"),
  occurrenceStart: timestamp("occurrence_start", { withTimezone: true }),
  subject: text("subject"),
  status: text("status").notNull().default("pending"), // pending/confirmed/done/cancelled
  note: text("note").notNull().default(""), // краткое содержание конкретного занятия
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Платёж ученика. Ссылка на оплату — ЮKassa (генерируется автоматически) или
// вручную («Мой налог»). Статус «оплачено» ставит вебхук ЮKassa или преподаватель.
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id")
    .notNull()
    .references(() => students.id, { onDelete: "cascade" }),
  amountKopecks: integer("amount_kopecks").notNull(),
  status: text("status").notNull().default("unpaid"), // unpaid/paid/canceled
  payLink: text("pay_link").notNull().default(""), // ссылка на оплату (ЮKassa/«Мой налог»)
  note: text("note").notNull().default(""), // напр. «Март, 4 занятия»
  // Происхождение счёта: manual — выставлен вручную; debt — автосчёт за проведённые
  // неоплаченные занятия; advance — автосчёт за занятия на месяц вперёд.
  kind: text("kind").notNull().default("manual"),
  // id платежа в ЮKassa (для сверки вебхука и обновления ссылки).
  providerPaymentId: text("provider_payment_id").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

// Состояние диалога Telegram-бота (для пошагового ввода, напр. текста заметки).
// Одна строка на чат владельца; действие + цель, что бот ждёт следующим сообщением.
export const botState = pgTable("bot_state", {
  chatId: text("chat_id").primaryKey(),
  action: text("action").notNull(), // напр. "student.note" | "lesson.note"
  targetId: text("target_id").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Короткая ссылка записи: прячет длинный подписанный токен за коротким кодом в URL
// (/z/<code>), чтобы ссылка выглядела дружелюбно. Код стабилен на пару (ученик, trial).
export const bookingLinks = pgTable("booking_links", {
  code: text("code").primaryKey(),
  token: text("token").notNull(), // тот же подписанный токен, что и в /?t=
  studentId: uuid("student_id").references(() => students.id, { onDelete: "cascade" }),
  trial: boolean("trial").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Настройки сервиса (ключ-значение): способ оплаты (yookassa/sbp) и текст реквизитов СБП.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Отметка «вопрос "как прошло занятие?" уже отправлен» по инстансу календаря —
// дедупликация pulse-крона (он опрашивает окно в сутки и не должен спрашивать дважды).
export const lessonPings = pgTable("lesson_pings", {
  instanceId: text("instance_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;
export type Lesson = typeof lessons.$inferSelect;
export type NewLesson = typeof lessons.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type BotState = typeof botState.$inferSelect;
export type BookingLink = typeof bookingLinks.$inferSelect;
