// Схема БД (Drizzle). Единый источник схемы — миграции в папке drizzle/.
// Postgres — система учёта (ученики, занятия, позже оплаты). Календарь остаётся
// источником правды для расписания; связь — через contactKey и calendar_event_id.
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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

// Платёж ученика. Оплата принимается вне сайта — через «Мой налог» (СБП + чек
// автоматически). Наша БД — учёт: сумма, статус (ставим вручную), ссылка на оплату.
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id")
    .notNull()
    .references(() => students.id, { onDelete: "cascade" }),
  amountKopecks: integer("amount_kopecks").notNull(),
  status: text("status").notNull().default("unpaid"), // unpaid/paid/canceled
  payLink: text("pay_link").notNull().default(""), // ссылка/QR счёта из «Мой налог»
  note: text("note").notNull().default(""), // напр. «Март, 4 занятия»
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

// Связь платёж ↔ занятия (многие-ко-многим): один счёт может покрывать комплект
// занятий или одно конкретное. Нужна для расчёта «оплачено ли занятие» (цвета, Фаза 3).
export const lessonPayments = pgTable(
  "lesson_payments",
  {
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    lessonId: uuid("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.paymentId, t.lessonId] }),
  })
);

export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;
export type Lesson = typeof lessons.$inferSelect;
export type NewLesson = typeof lessons.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
