// Цветовая пометка занятий в Google Calendar по оплате (Фаза 3), балансовая модель.
// Календарь — источник правды расписания; цвет — производная от учёта в БД.
//
// «Оплачено занятий» = сумма всех оплаченных счетов ученика ÷ его ставка ₽/час.
// Этим числом закрываем занятия ученика по времени, с самых ранних. Дальше — матрица:
//
//                 оплачено            не оплачено
//   проведено   🟢 зелёный (10)     🔴 красный (11)
//   будущее     🟠 оранжевый (6)    ⚪ нейтральный (без цвета)
//
// «Проведено» = занятие уже началось (start < сейчас). Повторяющаяся серия красится
// поштучно: каждый повтор — отдельный инстанс со своим цветом. Только подтверждённые
// занятия (pending не трогаем).
import {
  CALENDAR_ID,
  calendarClient,
  listContactMasters,
  listContactOccurrences,
  setEventColor,
} from "./google";
import { allocateBalance } from "./balance";
import { getStudent } from "./students";
import { sumPaidKopecks } from "./payments";
import { MISSED_COLOR_ID } from "./config";

// colorId Google Calendar: 10 Basil (зелёный), 11 Tomato (красный), 6 Tangerine (оранжевый).
// Серый (8, MISSED_COLOR_ID) — «пропущено», ставится вручную и покраской не трогается.
const COLOR = { paidPast: "10", unpaidPast: "11", paidFuture: "6" } as const;

// Пересчитывает и применяет цвета всех подтверждённых занятий ученика.
// Триггеры: отметка/снятие/удаление оплаты, подтверждение заявки, перенос.
export async function recolorStudent(studentId: string): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) return;

  // Оплаченные ЧАСЫ из баланса (ставка — за час). Без ставки посчитать нельзя — тогда
  // 0 (прошлые красные, будущие нейтральные), чтобы не осталось ложного «оплачено».
  const paidKopecks = await sumPaidKopecks(s.id);
  const paidHours = s.rateKopecks > 0 ? Math.floor(paidKopecks / s.rateKopecks) : 0;

  // 1. Сбрасываем цвет самих серий/событий в нейтраль — чтобы будущие неоплаченные
  // повторы не наследовали старый цвет мастера (иначе пришлось бы плодить исключения
  // на каждый повтор на 26 недель вперёд).
  for (const m of await listContactMasters(s.contactKey)) {
    // Серое одиночное событие — пропуск, отмеченный владельцем: не сбрасываем.
    if (m.colorId === MISSED_COLOR_ID) continue;
    if (m.colorId != null) {
      try {
        await setEventColor(m.id, null);
      } catch (e) {
        console.error("recolorStudent reset master failed", m.id, e);
      }
    }
  }

  // 2. Разворачиваем повторы в отдельные занятия (после сброса мастеров их инстансы —
  // уже нейтральные) и красим по балансовой раскладке (lib/balance.ts — общий walk
  // с кабинетом и автосчетами: «всё-или-ничего» по блокам, с самых ранних).
  // Серые (пропущенные) занятия исключаем: они не тарифицируются и остаются серыми.
  const occ = (await listContactOccurrences(s.contactKey)).filter(
    (o) => o.colorId !== MISSED_COLOR_ID
  );
  const { items } = allocateBalance(occ, paidHours, new Date());
  for (const o of items) {
    const target = o.paid
      ? o.past
        ? COLOR.paidPast
        : COLOR.paidFuture
      : o.past
        ? COLOR.unpaidPast
        : null; // будущее неоплаченное — нейтральный (без цвета)

    if (o.colorId === target) continue; // уже верный цвет — не трогаем
    try {
      await setEventColor(o.instanceId, target);
    } catch (e) {
      console.error("recolorStudent set occurrence failed", o.instanceId, e);
    }
  }
}

// «Не прошло»: красит занятие серым (пропуск, не тарифицируется) и пересчитывает
// остальные цвета/баланс ученика. Возвращает false, если событие не найдено.
export async function markLessonMissed(instanceId: string): Promise<boolean> {
  const cal = calendarClient();
  let ev;
  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId: instanceId });
    ev = res.data;
  } catch {
    return false;
  }
  await setEventColor(instanceId, MISSED_COLOR_ID);
  const studentId = ev.extendedProperties?.private?.studentId;
  if (studentId) {
    try {
      await recolorStudent(studentId);
    } catch (e) {
      console.error("markLessonMissed recolor failed", e);
    }
  }
  return true;
}

// «Прошло» после ошибочного «Не прошло»: снимает серый и возвращает занятие в тариф
// (пересчёт вернёт балансовый цвет). Для не-серого занятия ничего не делает.
export async function unmarkLessonMissed(instanceId: string): Promise<boolean> {
  const cal = calendarClient();
  let ev;
  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId: instanceId });
    ev = res.data;
  } catch {
    return false;
  }
  if (ev.colorId !== MISSED_COLOR_ID) return true; // и так в тарифе
  await setEventColor(instanceId, null);
  const studentId = ev.extendedProperties?.private?.studentId;
  if (studentId) {
    try {
      await recolorStudent(studentId);
    } catch (e) {
      console.error("unmarkLessonMissed recolor failed", e);
    }
  }
  return true;
}
