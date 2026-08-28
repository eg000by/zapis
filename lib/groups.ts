// Сервисный слой «Группы». Группа — до GROUP_LIMIT учеников на одном занятии:
// в календаре это ОДНО событие (как у обычного ученика, только под ключом группы),
// а деньги, кабинет и уведомления остаются персональными.
//
// Правило «или индивидуально, или в группе» жёсткое: при вступлении будущие личные
// занятия ученика снимаются с календаря. Иначе у него оказались бы два расписания и
// две цены в одном кабинете, а личные занятия остались бы невидимыми — кабинет
// участника группы показывает расписание группы.
import { and, asc, eq } from "drizzle-orm";
import { db } from "./db";
import { groups, students, type Group, type Student } from "./schema";
import { groupKey } from "./link";
import { applyLinksToEvents, deleteFutureEventsForContact } from "./google";

// Сколько человек имеет смысл вести одновременно на онлайн-занятии.
export const GROUP_LIMIT = 4;

export async function createGroup(input: {
  name: string;
  subject: string;
  rateKopecks: number;
}): Promise<Group> {
  // contactKey считается от id, поэтому строку сначала вставляем, потом дописываем
  // ключ. Временное значение уникально и в календарь попасть не успевает.
  const [row] = await db()
    .insert(groups)
    .values({
      name: input.name,
      subject: input.subject,
      rateKopecks: Math.max(0, input.rateKopecks),
      contactKey: `pending:${crypto.randomUUID()}`,
    })
    .returning();
  const [withKey] = await db()
    .update(groups)
    .set({ contactKey: groupKey(row.id) })
    .where(eq(groups.id, row.id))
    .returning();
  return withKey;
}

export async function listGroups(): Promise<Group[]> {
  return db().select().from(groups).orderBy(asc(groups.createdAt));
}

export async function getGroup(id: string): Promise<Group | null> {
  const [row] = await db().select().from(groups).where(eq(groups.id, id)).limit(1);
  return row ?? null;
}

export async function getGroupByContactKey(key: string): Promise<Group | null> {
  const [row] = await db().select().from(groups).where(eq(groups.contactKey, key)).limit(1);
  return row ?? null;
}

export async function updateGroup(
  id: string,
  fields: Partial<
    Pick<Group, "name" | "subject" | "rateKopecks" | "meetLink" | "boardLink" | "active" | "note">
  >
): Promise<void> {
  await db().update(groups).set(fields).where(eq(groups.id, id));
}

// Участники группы. Архивных не отсеиваем: преподавателю важно видеть состав целиком.
export async function listGroupMembers(groupId: string): Promise<Student[]> {
  return db()
    .select()
    .from(students)
    .where(eq(students.groupId, groupId))
    .orderBy(asc(students.createdAt));
}

export async function countGroupMembers(groupId: string): Promise<number> {
  return (await listGroupMembers(groupId)).length;
}

// Постоянные ссылки у группы общие: закрепляем их и в уже созданных событиях,
// иначе в описании занятия останется старая (та же логика, что у ученика).
export async function setGroupLink(
  id: string,
  which: "meetLink" | "boardLink",
  value: string
): Promise<void> {
  let link = (value || "").trim();
  if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
  await updateGroup(id, { [which]: link });
  const g = await getGroup(id);
  if (!g) return;
  try {
    await applyLinksToEvents(g.contactKey, { meetLink: g.meetLink, boardLink: g.boardLink });
  } catch (e) {
    console.error("setGroupLink: не удалось обновить события", id, e);
  }
}

export type JoinResult =
  | { ok: true; removedPersonal: number }
  | { ok: false; reason: "no-student" | "no-group" | "full" | "other-group" };

// Добавляет ученика в группу. Возвращает, сколько его личных будущих занятий было
// снято: преподавателю это надо видеть — время в сетке записи освободилось.
export async function addToGroup(studentId: string, groupId: string): Promise<JoinResult> {
  const [s] = await db().select().from(students).where(eq(students.id, studentId)).limit(1);
  if (!s) return { ok: false, reason: "no-student" };
  if (s.groupId && s.groupId !== groupId) return { ok: false, reason: "other-group" };
  const g = await getGroup(groupId);
  if (!g) return { ok: false, reason: "no-group" };
  if (s.groupId === groupId) return { ok: true, removedPersonal: 0 };
  if ((await countGroupMembers(groupId)) >= GROUP_LIMIT) return { ok: false, reason: "full" };

  await db().update(students).set({ groupId }).where(eq(students.id, studentId));

  // Личные будущие занятия снимаем: ученик теперь занимается в группе.
  let removedPersonal = 0;
  try {
    removedPersonal = await deleteFutureEventsForContact(s.contactKey);
  } catch (e) {
    console.error("addToGroup: не удалось убрать личные занятия", studentId, e);
  }
  return { ok: true, removedPersonal };
}

// Убирает ученика из группы. Занятия группы при этом не трогаем — они общие и
// продолжаются для остальных; у ушедшего просто пропадает расписание в кабинете.
export async function removeFromGroup(studentId: string): Promise<void> {
  await db().update(students).set({ groupId: null }).where(eq(students.id, studentId));
}

// Удаление группы: участники освобождаются (groupId → null через onDelete: set null),
// будущие занятия группы уходят из календаря, прошедшие остаются историей.
export async function deleteGroup(id: string): Promise<{ removed: number }> {
  const g = await getGroup(id);
  if (!g) return { removed: 0 };
  let removed = 0;
  try {
    removed = await deleteFutureEventsForContact(g.contactKey);
  } catch (e) {
    console.error("deleteGroup: не удалось убрать занятия", id, e);
  }
  await db().delete(groups).where(eq(groups.id, id));
  return { removed };
}

// Группы, в которых состоит ученик, — для кабинета и расчёта баланса. Группа одна
// (или ни одной), но обращение через функцию прячет доступ к БД от вызывающих.
export async function groupOfStudent(s: Pick<Student, "groupId">): Promise<Group | null> {
  return s.groupId ? getGroup(s.groupId) : null;
}

// Действующие участники группы. Через это разворачиваются групповые занятия в
// уведомлениях и счетах: у группового занятия нет одного «ученика», и без разворота
// участники не получали бы ни напоминаний, ни счёта после занятия.
export async function activeMembers(groupId: string): Promise<Student[]> {
  return db()
    .select()
    .from(students)
    .where(and(eq(students.groupId, groupId), eq(students.active, true)));
}
