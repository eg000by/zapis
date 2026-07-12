// Единая конфигурация сервиса записи. Меняйте значения здесь.

// Работаем и показываем время в московском времени (МСК, UTC+3, без перехода на летнее).
export const TIMEZONE = "Europe/Moscow";
export const MSK_OFFSET_MINUTES = 180; // МСК фиксировано = UTC+3

// Рабочие часы (в МСК). Слоты генерируются с шагом SLOT_STEP_MINUTES,
// начиная с WORK_START_HOUR; последний урок должен закончиться не позже WORK_END_HOUR.
export const WORK_START_HOUR = 10;
export const WORK_END_HOUR = 20;
// Длительность самого занятия (событие в календаре).
export const SLOT_MINUTES = 60;
// Перерыв после занятия.
export const BREAK_MINUTES = 10;
// Шаг сетки слотов = занятие + перерыв. Старты слотов идут через каждые 70 мин:
// 10:00, 11:10, 12:20, … последний — 18:10 (урок 18:10–19:10).
export const SLOT_STEP_MINUTES = SLOT_MINUTES + BREAK_MINUTES;

// На сколько дней вперёд открыта запись.
export const BOOKING_WINDOW_DAYS = 14;

// Расписание показывается «обезличенной» неделей (Пн–Вс), т.к. каждая неделя
// повторяется. Слот считается занятым, если хотя бы на одном из ближайших
// AVAILABILITY_WEEKS повторений (это же время в следующие недели) есть занятие.
export const AVAILABILITY_WEEKS = 4;

// Дни недели, доступные для записи (0 = воскресенье ... 6 = суббота).
// По умолчанию — все дни. Чтобы оставить только будни: [1, 2, 3, 4, 5].
export const WORK_DAYS = [0, 1, 2, 3, 4, 5, 6];

// Предметы для выбора в форме записи.
export const SUBJECTS = ["Питон", "Фронтенд", "ОГЭ информатика", "ЕГЭ информатика", "Другое"];

// Пометка предварительной (неподтверждённой) заявки в названии события.
export const PENDING_PREFIX = "⏳ ";

// Срок жизни персональной ссылки в часах. 0 — ссылка не протухает.
// Ссылка бессрочная: ученик записывается на постоянной основе и оплачивает занятия,
// поэтому одноразовость/протухание тут только мешали бы.
export const LINK_TTL_HOURS = 0;

// Сколько недель длится еженедельное повторение записи (~полгода вперёд).
export const RECURRENCE_WEEKS = 26;

// Максимум занятий (часов) на одного человека в неделю.
export const MAX_LESSONS_PER_WEEK = 4;

// Публичный адрес сайта — для ссылок вне HTTP-запроса (бот, return_url оплаты).
// Порядок: явный NEXT_PUBLIC_BASE_URL → VERCEL_PROJECT_PRODUCTION_URL (стабильный
// production-домен) → VERCEL_URL (адрес конкретного деплоя; крайний фолбэк).
export function siteBaseUrl(): string {
  const explicit = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (explicit && !explicit.includes("localhost")) return explicit;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) return `https://${prod.replace(/\/$/, "")}`;
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return explicit; // локальная разработка (напр. http://localhost:3000) либо пусто
}
