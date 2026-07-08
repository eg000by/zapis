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

export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;
export type Lesson = typeof lessons.$inferSelect;
export type NewLesson = typeof lessons.$inferInsert;
