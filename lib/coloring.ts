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
  listContactMasters,
  listContactOccurrences,
  setEventColor,
} from "./google";
import { getStudent } from "./students";
import { sumPaidKopecks } from "./payments";

// colorId Google Calendar: 10 Basil (зелёный), 11 Tomato (красный), 6 Tangerine (оранжевый).
const COLOR = { paidPast: "10", unpaidPast: "11", paidFuture: "6" } as const;

// Пересчитывает и применяет цвета всех подтверждённых занятий ученика.
// Триггеры: отметка/снятие/удаление оплаты, подтверждение заявки, перенос.
export async function recolorStudent(studentId: string): Promise<void> {
  const s = await getStudent(studentId);
  if (!s) return;

  // Оплаченные ЧАСЫ из баланса (ставка — за час). Без ставки посчитать нельзя — тогда
  // 0 (прошлые красные, будущие нейтральные), чтобы не осталось ложного «оплачено».
  const paidKopecks = await sumPaidKopecks(s.id);
  let remainingHours = s.rateKopecks > 0 ? Math.floor(paidKopecks / s.rateKopecks) : 0;

  // 1. Сбрасываем цвет самих серий/событий в нейтраль — чтобы будущие неоплаченные
  // повторы не наследовали старый цвет мастера (иначе пришлось бы плодить исключения
  // на каждый повтор на 26 недель вперёд).
  for (const m of await listContactMasters(s.contactKey)) {
    if (m.colorId != null) {
      try {
        await setEventColor(m.id, null);
      } catch (e) {
        console.error("recolorStudent reset master failed", m.id, e);
      }
    }
  }

  // 2. Разворачиваем повторы в отдельные занятия (после сброса мастеров их инстансы —
  // уже нейтральные) и красим нужные.
  const occ = await listContactOccurrences(s.contactKey);
  const now = Date.now();
  // Баланс закрывает занятия по времени, с самых ранних. Блок = одно событие = один
  // цвет, поделить нельзя — поэтому «всё-или-ничего»: блок считается оплаченным, только
  // если остатка часов хватает на ВСЮ его длину. Как только не хватило — дальше всё
  // неоплачено (не перескакиваем через большой блок к меньшему).
  let exhausted = false;
  for (const o of occ) {
    let paid = false;
    if (!exhausted && remainingHours >= o.hours) {
      paid = true;
      remainingHours -= o.hours;
    } else {
      exhausted = true;
    }
    const past = o.start.getTime() < now;
    const target = paid
      ? past
        ? COLOR.paidPast
        : COLOR.paidFuture
      : past
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
