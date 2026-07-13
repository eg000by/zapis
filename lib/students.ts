// Сервисный слой «Ученики». Общая логика для сайта (/admin) и Telegram-бота —
// обе поверхности дергают эти функции, а не пишут в БД напрямую (паритет админки).
// Календарь остаётся источником правды для расписания; здесь — учётные данные ученика.
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { students, type Student } from "./schema";

// Заводит или обновляет ученика по contactKey (HMAC имени+предмета+tg, lib/link.ts).
// contactKey стабилен для связки имя/предмет/tg, поэтому повторная бронь того же
// ученика не плодит дубликаты, а освежает поля.
// trial: true метит НОВОГО ученика пробным; для существующего пробный статус может
// только сняться (trial=false — регулярная ссылка/запись «повышает» ученика),
// обратного даунгрейда полноценного в пробные нет.
// rateKopecks: задаёт ставку при создании; для существующего ученика обновляет её,
// только если передана положительная (нулём/отсутствием существующую не затираем).
export async function upsertStudent(input: {
  name: string;
  subject: string;
  tg: string;
  contactKey: string;
  trial?: boolean;
  rateKopecks?: number;
}): Promise<Student> {
  const [row] = await db()
    .insert(students)
    .values({
      name: input.name,
      subject: input.subject,
      tg: input.tg,
      contactKey: input.contactKey,
      trial: input.trial ?? false,
      rateKopecks: input.rateKopecks && input.rateKopecks > 0 ? input.rateKopecks : 0,
    })
    .onConflictDoUpdate({
      target: students.contactKey,
      set: {
        name: input.name,
        subject: input.subject,
        tg: input.tg,
        ...(input.trial === false ? { trial: false } : {}),
        ...(input.rateKopecks && input.rateKopecks > 0
          ? { rateKopecks: input.rateKopecks }
          : {}),
      },
    })
    .returning();
  return row;
}

// Пробные ученики, которым ещё не отправлен вопрос «пробное прошло — что дальше?».
export async function listTrialPending(): Promise<Student[]> {
  return db()
    .select()
    .from(students)
    .where(and(eq(students.trial, true), eq(students.active, true), isNull(students.trialNotifiedAt)));
}

export async function listStudents(): Promise<Student[]> {
  return db().select().from(students).orderBy(desc(students.createdAt));
}

export async function getStudent(id: string): Promise<Student | null> {
  const [row] = await db().select().from(students).where(eq(students.id, id)).limit(1);
  return row ?? null;
}

export async function getStudentByContactKey(key: string): Promise<Student | null> {
  const [row] = await db().select().from(students).where(eq(students.contactKey, key)).limit(1);
  return row ?? null;
}

export async function updateStudent(
  id: string,
  fields: Partial<
    Pick<
      Student,
      | "name"
      | "tg"
      | "subject"
      | "rateKopecks"
      | "active"
      | "note"
      | "trial"
      | "trialNotifiedAt"
      | "meetLink"
      | "tgChatId"
    >
  >
): Promise<void> {
  await db().update(students).set(fields).where(eq(students.id, id));
}

// Полное удаление ученика из учёта. Каскадом (FK onDelete: cascade) уходят его
// занятия, оплаты, связи lesson_payments и короткие ссылки записи. События в Google
// Calendar остаются нетронутыми — там источник правды расписания. Действие необратимо.
export async function deleteStudent(id: string): Promise<void> {
  await db().delete(students).where(eq(students.id, id));
}
