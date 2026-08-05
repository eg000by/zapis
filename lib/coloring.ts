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
import { allocateBalance, computeStudentBalance } from "./balance";
import { getStudent } from "./students";
import { FREE_COLOR_ID, MISSED_COLOR_ID } from "./config";

// colorId Google Calendar: 10 Basil (зелёный), 11 Tomato (красный), 6 Tangerine (оранжевый).
// Серый (8) — «пропущено», Sage (2) — «бесплатное»: оба ставятся отдельно, покраской не
// трогаются и в тарификацию не идут.
const COLOR = { paidPast: "10", unpaidPast: "11", paidFuture: "6" } as const;
const isUntariffed = (colorId: string | null) =>
  colorId === MISSED_COLOR_ID || colorId === FREE_COLOR_ID;

// Пересчитывает и применяет цвета всех подтверждённых занятий ученика.
// Триггеры: отметка/снятие/удаление оплаты, подтверждение заявки, перенос.
export async function recolorStudent(studentId: string): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) return;
  // Пробное занятие бесплатное: пока ученик пробный, красить по оплате нечего —
  // иначе прошедшее пробное стало бы «долгом» (красным). Цвет появится при
  // переводе в полноценные: markPastLessonsFree ставит прошедшему пробному Sage,
  // а дальнейшие занятия красятся уже по балансу.
  if (s.trial) return;

  // 1. Сбрасываем цвет самих серий/событий в нейтраль — чтобы будущие неоплаченные
  // повторы не наследовали старый цвет мастера (иначе пришлось бы плодить исключения
  // на каждый повтор на 26 недель вперёд).
  for (const m of await listContactMasters(s.contactKey)) {
    // Серое (пропуск) или Sage (бесплатное) одиночное событие — не сбрасываем.
    if (isUntariffed(m.colorId)) continue;
    if (m.colorId != null) {
      try {
        await setEventColor(m.id, null);
      } catch (e) {
        console.error("recolorStudent reset master failed", m.id, e);
      }
    }
  }

  // 2. Красим по той же балансовой раскладке, что видит ученик в кабинете
  // (computeStudentBalance: повторы развёрнуты поштучно, «всё-или-ничего» по блокам,
  // с самых ранних; пропущенные и бесплатные исключены). Один источник правды —
  // иначе календарь и кабинет могут разойтись (напр. оплаченный пакет при нулевой
  // ставке красил бы занятия «оплачено», а кабинет не показывал бы вообще ничего).
  // Ставка не задана (balance === null) — считаем, что не оплачено ничего: прошлые
  // красные, будущие нейтральные, ложного «оплачено» не остаётся.
  const balance = await computeStudentBalance(s.id, s);
  const items =
    balance?.items ??
    allocateBalance(
      (await listContactOccurrences(s.contactKey)).filter((o) => !isUntariffed(o.colorId)),
      0,
      new Date()
    ).items;
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

// Помечает все ПРОШЕДШИЕ занятия ученика бесплатными (Sage) — при переводе пробного
// в полноценные, чтобы состоявшееся пробное не висело долгом. Уже серые/бесплатные
// не трогаем. Будущие занятия не затрагиваются.
export async function markPastLessonsFree(contactKey: string): Promise<void> {
  const now = Date.now();
  for (const o of await listContactOccurrences(contactKey)) {
    if (o.start.getTime() >= now || isUntariffed(o.colorId)) continue;
    try {
      await setEventColor(o.instanceId, FREE_COLOR_ID);
    } catch (e) {
      console.error("markPastLessonsFree failed", o.instanceId, e);
    }
  }
}

// Результат отметки занятия: найдено ли событие и чьё оно (id ученика нужен
// вызывающему, чтобы пересчитать счета — занятие могло стать/перестать быть долгом).
export interface LessonMarkResult {
  found: boolean;
  studentId: string | null;
}

// «Не прошло»: красит занятие серым (пропуск, не тарифицируется) и пересчитывает
// остальные цвета/баланс ученика.
export async function markLessonMissed(instanceId: string): Promise<LessonMarkResult> {
  const cal = calendarClient();
  let ev;
  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId: instanceId });
    ev = res.data;
  } catch {
    return { found: false, studentId: null };
  }
  await setEventColor(instanceId, MISSED_COLOR_ID);
  const studentId = ev.extendedProperties?.private?.studentId || null;
  if (studentId) {
    try {
      await recolorStudent(studentId);
    } catch (e) {
      console.error("markLessonMissed recolor failed", e);
    }
  }
  return { found: true, studentId };
}

// «Прошло»: подтверждает, что занятие состоялось. Снимает ошибочный серый (пропуск),
// если был, и в ЛЮБОМ случае пересчитывает цвета ученика — чтобы прошедшее неоплаченное
// занятие покрасилось в «долг» (красный), а не осталось нейтральным (время само по себе
// перекраску не запускает — триггеры это оплата/подтверждение/пропуск).
export async function unmarkLessonMissed(instanceId: string): Promise<LessonMarkResult> {
  const cal = calendarClient();
  let ev;
  try {
    const res = await cal.events.get({ calendarId: CALENDAR_ID, eventId: instanceId });
    ev = res.data;
  } catch {
    return { found: false, studentId: null };
  }
  if (ev.colorId === MISSED_COLOR_ID) await setEventColor(instanceId, null);
  const studentId = ev.extendedProperties?.private?.studentId || null;
  if (studentId) {
    try {
      await recolorStudent(studentId);
    } catch (e) {
      console.error("unmarkLessonMissed recolor failed", e);
    }
  }
  return { found: true, studentId };
}
