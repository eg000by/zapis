// Сервисный слой «Ученики». Общая логика для сайта (/admin) и Telegram-бота —
// обе поверхности дергают эти функции, а не пишут в БД напрямую (паритет админки).
// Календарь остаётся источником правды для расписания; здесь — учётные данные ученика.
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { students, type Student } from "./schema";
import { detectExamTariff } from "./config";
import { applyMeetLinkToEvents, deleteFutureEventsForContact } from "./google";

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
  // Ставка при создании: явная (если передана) → иначе часовая ставка экзаменационного
  // тарифа по предмету (ОГЭ/ЕГЭ) → иначе 0 (задаётся позже). На апдейт существующего
  // ученика это не влияет (set ниже трогает ставку только при явной положительной).
  //
  // Пробному ученику ставку НЕ проставляем: биллинг включается только ставкой, и с
  // ней пробное занятие сразу стало бы долгом со счётом и предложением пакета — до
  // того, как преподаватель перевёл ученика в полноценные (makeStudentFull, где
  // прошедшее пробное помечается бесплатным и подставляется та же тарифная ставка).
  const trial = input.trial ?? false;
  const examHourly = trial ? 0 : (detectExamTariff(input.subject)?.hourlyKopecks ?? 0);
  const insertRate =
    input.rateKopecks && input.rateKopecks > 0 ? input.rateKopecks : examHourly;
  const [row] = await db()
    .insert(students)
    .values({
      name: input.name,
      subject: input.subject,
      tg: input.tg,
      contactKey: input.contactKey,
      trial,
      rateKopecks: insertRate,
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

// Ученик по его чату в Telegram — для /stop (отключить уведомления). Пустой chatId
// не ищем: пустая строка стоит у всех неподключённых и нашла бы случайного ученика.
export async function getStudentByTgChatId(chatId: string): Promise<Student | null> {
  if (!chatId) return null;
  const [row] = await db().select().from(students).where(eq(students.tgChatId, chatId)).limit(1);
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

// Пробный → полноценный: снимает trial и задаёт ставку — явную, а если её не указали,
// часовую ставку экзаменационного тарифа по предмету (ОГЭ/ЕГЭ). Общая операция для
// /admin и бота; пометку прошедших занятий бесплатными и перекраску делает вызывающий
// (они живут в lib/coloring.ts, который сам зависит от учеников).
export async function promoteStudentToFull(
  id: string,
  rateKopecks?: number
): Promise<Student | null> {
  const s = await getStudent(id);
  if (!s) return null;
  const explicit = rateKopecks && rateKopecks > 0 ? rateKopecks : 0;
  const fallback = s.rateKopecks > 0 ? 0 : (detectExamTariff(s.subject)?.hourlyKopecks ?? 0);
  const rate = explicit || fallback;
  await updateStudent(id, { trial: false, ...(rate > 0 ? { rateKopecks: rate } : {}) });
  return { ...s, trial: false, rateKopecks: rate > 0 ? rate : s.rateKopecks };
}

// Архив/возврат из архива. Общая операция для /admin и бота — иначе поверхности
// разъезжаются: в боте кнопка снимала бы занятия, а в админке нет.
//
// Архив означает «ученик больше не занимается»: его будущие занятия снимаются с
// календаря. Иначе они продолжают держать чужое время в сетке записи, красятся по
// оплате и порождают уведомления «скоро занятие» — ровно то, чего архив и должен
// избежать. Прошедшие занятия остаются как история (их не трогаем).
//
// Возврат из архива занятия НЕ восстанавливает: удалённое событие календаря вернуть
// нечем, ученик записывается заново по своей ссылке.
//
// Недоступность календаря не отменяет саму архивацию — учётная запись важнее уборки,
// поэтому сообщаем об этом флагом, а не исключением.
export async function setStudentArchived(
  id: string,
  archived: boolean
): Promise<{ removed: number; calendarFailed: boolean }> {
  const s = await getStudent(id);
  if (!s) return { removed: 0, calendarFailed: false };
  await updateStudent(id, { active: !archived });
  if (!archived) return { removed: 0, calendarFailed: false };
  try {
    return { removed: await deleteFutureEventsForContact(s.contactKey), calendarFailed: false };
  } catch (e) {
    console.error("setStudentArchived: не удалось убрать будущие занятия", id, e);
    return { removed: 0, calendarFailed: true };
  }
}

// Закрепляет ссылку на Телемост за учеником и обновляет её в описании уже созданных
// событий календаря (best-effort). Общая операция для /admin и бота — иначе
// последовательность «сохранить + применить» копируется по поверхностям и разъезжается.
export async function setStudentMeetLink(id: string, meetLink: string): Promise<void> {
  let link = (meetLink || "").trim();
  // В форме /admin легко вставить адрес без схемы — нормализуем, иначе ссылка
  // в описании события и в кабинете окажется нерабочей.
  if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
  await updateStudent(id, { meetLink: link });
  try {
    const s = await getStudent(id);
    if (s) await applyMeetLinkToEvents(s.contactKey, link);
  } catch (e) {
    console.error("applyMeetLinkToEvents failed", e);
  }
}

// Полное удаление ученика из учёта. Каскадом (FK onDelete: cascade) уходят его
// занятия, оплаты, связи lesson_payments и короткие ссылки записи. События в Google
// Calendar остаются нетронутыми — там источник правды расписания. Действие необратимо.
export async function deleteStudent(id: string): Promise<void> {
  await db().delete(students).where(eq(students.id, id));
}
