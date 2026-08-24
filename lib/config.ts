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

// Сколько месяцев листается календарь «выбрать другую дату» (считая текущий).
// Он не открывает запись «на любой срок», а только сдвигает сетку на нужную
// неделю: занятость всё равно проверяется по календарю, а сама запись — сервером.
export const CALENDAR_MONTHS = 3;

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

// Тарифы подготовки к экзаменам (ОГЭ/ЕГЭ по информатике). У экзаменационных учеников
// два варианта оплаты в кабинете: поштучно по часовой ставке и пакет из packageLessons
// занятий со скидкой. Пакет тарифицируется не деньгами÷ставку, а ровно packageLessons
// часами (иначе скидка «съела» бы часть занятий).
//
// Пакет НЕ называется «месяцем»: 8 занятий при одном занятии в неделю — это два месяца,
// а не месяц. Везде (кабинет, счёт, бот) он называется по числу занятий.
export interface ExamTariff {
  kind: "oge" | "ege";
  label: string; // «ОГЭ» / «ЕГЭ» — для подписей в кабинете
  subjects: string[]; // канонические названия предмета (из SUBJECTS) — якорь тарифа
  hourlyKopecks: number; // цена одного занятия (часа)
  packageLessons: number; // занятий в пакете
  packageKopecks: number; // цена пакета (= hourly × lessons − PACKAGE_DISCOUNT_PERCENT)
}

// Скидка пакета против поштучной оплаты. Цены тарифов ниже посчитаны от неё.
export const PACKAGE_DISCOUNT_PERCENT = 15;

// Цена пакета по часовой ставке и числу занятий, со скидкой PACKAGE_DISCOUNT_PERCENT.
export function packagePrice(hourlyKopecks: number, lessons: number): number {
  return Math.round((hourlyKopecks * lessons * (100 - PACKAGE_DISCOUNT_PERCENT)) / 100);
}

// Название пакета для ученика и счёта: «пакет из 8 занятий».
export function packageTitle(lessons: number): string {
  return `пакет из ${lessons} занятий`;
}

export const EXAM_TARIFFS: ExamTariff[] = [
  {
    kind: "ege",
    label: "ЕГЭ",
    subjects: ["ЕГЭ информатика"],
    hourlyKopecks: 250000,
    packageLessons: 8,
    packageKopecks: packagePrice(250000, 8), // 17 000 ₽ вместо 20 000 ₽
  },
  {
    kind: "oge",
    label: "ОГЭ",
    subjects: ["ОГЭ информатика"],
    hourlyKopecks: 120000,
    packageLessons: 8,
    packageKopecks: packagePrice(120000, 8), // 8 160 ₽ вместо 9 600 ₽
  },
];

// Определяет экзаменационный тариф по предмету ученика.
// null — обычный предмет (часовая ставка; пакета со скидкой нет).
//
// Предмет — свободный текст (в боте есть «Другое»), поэтому проверять вхождение
// подстроки нельзя: «Не ЕГЭ, просто информатика» молча включило бы экзаменационную
// ставку, поштучный автосчёт и пакет. Экзаменационным считаем только предмет из
// канонического списка тарифа либо начинающийся с «ЕГЭ»/«ОГЭ» отдельным словом.
export function detectExamTariff(subject: string): ExamTariff | null {
  const s = (subject || "").trim().toLowerCase();
  if (!s) return null;
  for (const t of EXAM_TARIFFS) {
    if (t.subjects.some((n) => n.toLowerCase() === s)) return t;
  }
  // Начало строки отдельным словом («ЕГЭ по информатике»). \b с кириллицей не
  // работает (ASCII-границы), поэтому разделитель перечисляем явно.
  const head = /^(егэ|огэ)(?=$|[\s.,:;—-])/.exec(s)?.[1];
  if (head === "егэ") return EXAM_TARIFFS.find((t) => t.kind === "ege") ?? null;
  if (head === "огэ") return EXAM_TARIFFS.find((t) => t.kind === "oge") ?? null;
  return null;
}

// Экономия пакета против поштучной оплаты — по ФАКТИЧЕСКОЙ ставке ученика и цене
// уже выставленного счёта (ставку преподаватель может задать индивидуально, а цена
// пакета в счёте зафиксирована на момент выставления). Если выгоды нет — нули.
export function packageSavings(input: {
  hourlyKopecks: number;
  lessons: number;
  packageKopecks: number;
}): { fullKopecks: number; kopecks: number; percent: number } {
  const fullKopecks = input.hourlyKopecks * input.lessons;
  const kopecks = fullKopecks - input.packageKopecks;
  if (kopecks <= 0 || fullKopecks <= 0) return { fullKopecks, kopecks: 0, percent: 0 };
  return { fullKopecks, kopecks, percent: Math.round((kopecks / fullKopecks) * 100) };
}

// Telegram преподавателя для связи с учениками (без «@»). Показывается подписью на
// всех страницах ученика — включая экраны «ссылка истекла/неверна», где ученик уже
// не может ничего сделать сам. Пусто — подпись не показывается.
export const TEACHER_TG = "eg0by";
export const teacherTgUrl = () => (TEACHER_TG ? `https://t.me/${TEACHER_TG}` : "");

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
