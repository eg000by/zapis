// Единая конфигурация сервиса записи. Меняйте значения здесь.

// Работаем и показываем время в московском времени (МСК, UTC+3, без перехода на летнее).
export const TIMEZONE = "Europe/Moscow";
export const MSK_OFFSET_MINUTES = 180; // МСК фиксировано = UTC+3

// Длительность самого занятия (событие в календаре).
export const SLOT_MINUTES = 60;
// Перерыв после занятия.
export const BREAK_MINUTES = 10;
// Шаг сетки слотов = занятие + перерыв. Старты слотов идут через каждые 70 мин.
export const SLOT_STEP_MINUTES = SLOT_MINUTES + BREAK_MINUTES;

// На сколько дней вперёд открыта запись.
export const BOOKING_WINDOW_DAYS = 14;

// Расписание показывается «обезличенной» неделей (Пн–Вс), т.к. каждая неделя
// повторяется. Слот считается занятым, если хотя бы на одном из ближайших
// AVAILABILITY_WEEKS повторений (это же время в следующие недели) есть занятие.
export const AVAILABILITY_WEEKS = 4;

// Рабочие окна по дням недели (0 = воскресенье … 6 = суббота), в часах МСК.
// Слоты в дне идут с шагом SLOT_STEP_MINUTES от start; последний урок обязан
// закончиться не позже end. Дня нет в карте → он недоступен для записи.
export const WORK_HOURS: Record<number, { start: number; end: number }> = {
  1: { start: 15, end: 21 }, // Пн
  2: { start: 9, end: 17 }, // Вт
  3: { start: 15, end: 21 }, // Ср
  4: { start: 9, end: 17 }, // Чт
  6: { start: 9, end: 17 }, // Сб
  // Пятница (5) и воскресенье (0) — выходные: в сетке показываются, но серыми.
};

// Рабочее окно конкретного дня недели (или null, если день недоступен).
export function dayWindow(weekday: number): { start: number; end: number } | null {
  return WORK_HOURS[weekday] ?? null;
}

// Предметы для выбора в форме записи.
export const SUBJECTS = ["Питон", "Фронтенд", "ОГЭ информатика", "ЕГЭ информатика", "Другое"];

// Пометка предварительной (неподтверждённой) заявки в названии события.
export const PENDING_PREFIX = "⏳ ";

// Цвет Google Calendar «занятие пропущено» (8 — графитовый/серый). Пропущенное занятие
// не тарифицируется: исключается из балансовой раскладки, покраска его не трогает.
// Пометить можно кнопкой «Не прошло» из утреннего отчёта или вручную серым в календаре.
export const MISSED_COLOR_ID = "8";

// Цвет «бесплатное занятие» (2 — Sage, приглушённо-зелёный). Ставится прошедшему
// пробному при переводе ученика в полноценные — оно не должно висеть долгом.
// Как и серое, исключается из тарификации и покраской не трогается.
export const FREE_COLOR_ID = "2";

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
