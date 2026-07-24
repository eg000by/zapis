// Общие помощники e2e: персональный токен и перехват /api/* (page.route).
import type { Page } from "@playwright/test";
import { encodeToken } from "../lib/link";

// Приветствие берёт последнее слово имени — «Здравствуйте, Егор!».
export const INFO = { name: "Тестовый Егор", subject: "Питон", tg: "", trial: false };

export function tokenUrl(info: Partial<typeof INFO> = {}): string {
  return `/?t=${encodeURIComponent(encodeToken({ ...INFO, ...info }))}`;
}

// Сетка: во вторнике свободные и занятый слоты, среда, и пятница-выходной (closed).
export const SLOTS = {
  days: [
    {
      date: "2026-07-14",
      title: "Вторник, 14 июля",
      weekday: "Вт",
      closed: false,
      slots: [
        { start: "2026-07-14T07:00:00.000Z", time: "10:00", busy: false },
        { start: "2026-07-14T08:10:00.000Z", time: "11:10", busy: true },
        { start: "2026-07-14T09:20:00.000Z", time: "12:20", busy: false },
      ],
    },
    {
      date: "2026-07-15",
      title: "Среда, 15 июля",
      weekday: "Ср",
      closed: false,
      slots: [{ start: "2026-07-15T07:00:00.000Z", time: "10:00", busy: false }],
    },
    {
      date: "wd-5",
      title: "Пятница",
      weekday: "Пт",
      closed: true,
      slots: [],
    },
  ],
};

// Полная неделя из 7 дней (Пн–Вс) — для проверки, что на мобилке помещаются все дни.
export const SLOTS_WEEK = {
  days: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((weekday, i) => ({
    date: `wd-${i}`,
    title: `День ${weekday}`,
    weekday,
    closed: weekday === "Пт" || weekday === "Вс",
    slots:
      weekday === "Пт" || weekday === "Вс"
        ? []
        : [{ start: `2026-07-${13 + i}T07:00:00.000Z`, time: "10:00", busy: false }],
  })),
};

// Пустой ответ /api/my (новый ученик).
export const MY_EMPTY = {
  events: [],
  payments: [],
  balance: null,
  meetLink: "",
  payHint: "",
  tg: { connected: false, link: "" },
  packageOffer: null,
  nextLesson: null,
};

// Кабинет экзаменационного ученика (ЕГЭ): поштучный счёт + карточка месячного пакета.
// Есть подтверждённое занятие — иначе «занятийные» блоки в кабинете не показываются.
export const MY_EGE = {
  events: [
    {
      id: "ege1",
      student: "Тестовый Егор",
      subject: "ЕГЭ информатика",
      status: "confirmed",
      start: "2026-07-14T07:00:00.000Z",
      recurring: true,
      weeks: 26,
      lessons: 1,
      moved: false,
      origStart: "",
    },
  ],
  payments: [
    { id: "adv", amountKopecks: 250000, note: "Автосчёт: следующее занятие (1 ч)", payLink: "https://yookassa.test/lesson", kind: "advance" },
  ],
  balance: null,
  meetLink: "",
  payHint: "",
  tg: { connected: false, link: "" },
  packageOffer: {
    label: "ЕГЭ",
    lessons: 8,
    amountKopecks: 1800000,
    perLessonKopecks: 250000,
    savingsKopecks: 200000,
    savingsPercent: 10,
    payLink: "https://yookassa.test/package",
  },
  nextLesson: null,
};

// Кабинет ученика с подтверждённой еженедельной записью, балансом и счётом.
export const MY_FULL = {
  events: [
    {
      id: "ev1",
      student: "Тестовый Егор",
      subject: "Питон",
      status: "confirmed",
      start: "2026-07-14T07:00:00.000Z",
      recurring: true,
      weeks: 26,
      lessons: 1,
      moved: false,
      origStart: "",
    },
  ],
  packageOffer: null,
  payments: [
    { id: "p1", amountKopecks: 600000, note: "Автосчёт: занятия на месяц вперёд (4 ч)", payLink: "https://yookassa.test/pay", kind: "advance" },
  ],
  balance: {
    debtKopecks: 150000,
    debtHours: 1,
    aheadHours: 0,
    paidUntil: null,
    balanceKopecks: 0,
    rateKopecks: 150000,
  },
  meetLink: "https://telemost.yandex.ru/j/e2e",
  payHint: "",
  tg: { connected: false, link: "https://t.me/e2e_bot?start=stu-1" },
  nextLesson: "2026-07-14T07:00:00.000Z",
};

// Перехватывает все /api/* (ничего не уходит в настоящие календарь/БД).
export async function mockApi(
  page: Page,
  opts: { my?: unknown; slots?: unknown; book?: { status: number; body: unknown }; myDelayMs?: number } = {}
): Promise<void> {
  const my = opts.my ?? MY_EMPTY;
  const slots = opts.slots ?? SLOTS;
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/slots")) {
      return route.fulfill({ json: slots });
    }
    if (url.includes("/api/my")) {
      if (opts.myDelayMs) await new Promise((r) => setTimeout(r, opts.myDelayMs));
      return route.fulfill({ json: my });
    }
    if (url.includes("/api/book")) {
      const res = opts.book ?? { status: 200, body: { ok: true, when: "Вт, 14 июля, 10:00 (МСК), еженедельно" } };
      return route.fulfill({ status: res.status, json: res.body });
    }
    if (url.includes("/api/occurrences")) {
      return route.fulfill({ json: { occurrences: ["2026-07-14T07:00:00.000Z", "2026-07-21T07:00:00.000Z"] } });
    }
    return route.fulfill({ json: { ok: true } });
  });
}
