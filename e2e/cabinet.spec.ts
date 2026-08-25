// Личный кабинет ученика с записями: плашки, счета, способ оплаты, отсутствие
// «25-го кадра» (сетка не мелькает, пока грузится /api/my).
import { expect, test } from "@playwright/test";
import { MY_EGE, MY_FULL, MY_GROUP, SLOTS_WEEK, mockApi, tokenUrl } from "./helpers";

test("кабинет: записи вместо сетки, все плашки на месте", async ({ page }) => {
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());

  // Сетки нет — есть кабинет, и подзаголовок это подтверждает.
  await expect(page.getByText("Ваши записи")).toBeVisible();
  await expect(page.locator(".slots-grid")).toHaveCount(0);
  const head = page.locator(".panel-head");
  await expect(head).toContainText("Занятия по предмету «Питон»");
  // Метка режима — только у группы: индивидуальному подписывать нечего.
  await expect(head.locator(".panel-badge")).toHaveCount(0);
  await expect(page.locator(".hero")).toHaveCount(0);

  // Плашки: ближайшее занятие, Телемост.
  await expect(page.getByText("Ближайшее занятие")).toBeVisible();
  const meet = page.locator("a.panel-join");
  await expect(meet).toContainText("Телемост");
  await expect(meet).toHaveAttribute("href", "https://telemost.yandex.ru/j/e2e");
  // Кнопки «Подключить уведомления в Telegram» больше нет.
  await expect(page.locator("a.panel-tg")).toHaveCount(0);

  // Деньги — одним блоком: итог, разбивка «долг / вперёд», срок и история оплат.
  const pay = page.locator(".pay-card");
  await expect(pay).toContainText("К оплате сейчас");
  await expect(pay.locator(".pay-total")).toHaveText("7 500 ₽"); // 1 500 долг + 6 000 вперёд
  await expect(pay.locator(".pay-split")).toContainText("долг за прошедшие — 1 500 ₽");
  await expect(pay.locator(".pay-split")).toContainText("вперёд — 6 000 ₽");
  await expect(pay.locator(".pay-due.overdue")).toContainText("оплатите");
  await expect(pay.locator(".pay-history summary")).toContainText("Оплачено ранее (1)");

  // Запись: еженедельно, подтверждена, с кнопками управления.
  // (.my-row есть и в «К оплате» — берём строку именно записи.)
  const row = page.locator(".my-card .my-row").first();
  await expect(row).toContainText("еженедельно");
  // Имя и предмет ученику не показываем: он открыл свой кабинет по личной ссылке.
  await expect(row).not.toContainText("Тестовый Егор — Питон");
  await expect(row).toContainText("подтверждено");
  await expect(row.getByRole("button", { name: "Перенести" })).toBeVisible();
});

test("счета с ЮKassa: у каждого своя кнопка оплаты со ссылкой", async ({ page }) => {
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());
  const links = page.locator(".pay-card .pay-btn");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("href", "https://yookassa.test/debt");
  await expect(links.nth(1)).toHaveAttribute("href", "https://yookassa.test/pay");
});

test("один счёт — одна кнопка «Оплатить <сумма>»", async ({ page }) => {
  const my = { ...MY_FULL, payments: [MY_FULL.payments[1]] };
  await mockApi(page, { my });
  await page.goto(tokenUrl());
  const btn = page.locator(".pay-card .pay-btn.primary");
  await expect(btn).toContainText("Оплатить 6 000 ₽");
  await expect(btn).toHaveAttribute("href", "https://yookassa.test/pay");
  // Долга нет — срок считается по ближайшему занятию, без красного предупреждения.
  await expect(page.locator(".pay-due.overdue")).toHaveCount(0);
  await expect(page.locator(".pay-due")).toContainText("Оплатить до");
});

test("режим «СБП-перевод»: реквизиты вместо кнопки оплаты", async ({ page }) => {
  const my = {
    ...MY_FULL,
    payHint: "Перевод по СБП на номер 8 927 750-23-78 (Т-Банк или Сбер)",
    payments: MY_FULL.payments.map((p) => ({ ...p, payLink: "" })),
  };
  await mockApi(page, { my });
  await page.goto(tokenUrl());
  await expect(page.getByText("Перевод по СБП на номер")).toBeVisible();
  await expect(page.locator(".pay-btn")).toHaveCount(0);
  await expect(page.getByText("ждём ссылку на оплату")).toHaveCount(0);
});

test("экзамен ЕГЭ: два способа оплатить ОДИН счёт — поштучно или пакетом", async ({ page }) => {
  await mockApi(page, { my: MY_EGE });
  await page.goto(tokenUrl());

  // Сумма к оплате — только поштучный счёт: пакет её не увеличивает, а заменяет.
  const pay = page.locator(".pay-card");
  await expect(pay.locator(".pay-total")).toHaveText("2 500 ₽");

  const opts = pay.locator(".pay-opt");
  await expect(opts).toHaveCount(2);
  await expect(opts.nth(0)).toContainText("По одному занятию");
  await expect(opts.nth(0).locator(".pay-opt-price")).toHaveText("2 500 ₽");

  const pkg = pay.locator(".pay-opt.best");
  await expect(pkg).toContainText("8 занятий сразу");
  await expect(pkg.locator(".pay-opt-price")).toHaveText("17 000 ₽");
  await expect(pkg.locator(".pkg-save")).toContainText("−15%");
  await expect(pkg.locator(".pkg-save")).toContainText("выгода 3 000 ₽");
  await expect(pkg).toContainText("Пакет закрывает текущий счёт");
  await expect(pkg.getByRole("link", { name: /Оплатить пакет/ })).toHaveAttribute(
    "href",
    "https://yookassa.test/package"
  );
});

test("обычный ученик: второй вариант — весь месяц одним платежом, без скидки", async ({ page }) => {
  const my = {
    ...MY_FULL,
    packageOffer: {
      exam: false,
      label: "",
      lessons: 5,
      amountKopecks: 750000,
      perLessonKopecks: 150000,
      savingsKopecks: 0, // скидки нет — бейдж выгоды не показываем
      savingsPercent: 0,
      payLink: "https://yookassa.test/month",
    },
  };
  await mockApi(page, { my });
  await page.goto(tokenUrl());

  const pay = page.locator(".pay-card");
  await expect(pay.locator(".pay-total")).toHaveText("7 500 ₽"); // предложение сумму не меняет
  const month = pay.locator(".pay-opt.best");
  await expect(month).toContainText("Месяц вперёд · 5 занятий");
  await expect(month.locator(".pay-opt-price")).toHaveText("7 500 ₽");
  await expect(month.locator(".pkg-save")).toHaveCount(0);
  await expect(month).toContainText("закрывает текущий счёт");
  await expect(month.getByRole("link", { name: /Оплатить месяц/ })).toHaveAttribute(
    "href",
    "https://yookassa.test/month"
  );
});

test("оплачено вперёд: видно на самом занятии и в блоке оплаты, счёта нет", async ({ page }) => {
  // Ученик оплатил ближайшее занятие вперёд: счетов нет, но кабинет обязан
  // показать, за что деньги ушли — иначе оплата выглядит как «ничего не изменилось».
  const my = {
    ...MY_FULL,
    payments: [],
    balance: {
      ...MY_FULL.balance,
      debtKopecks: 0,
      debtHours: 0,
      aheadHours: 1,
      paidUntil: "2026-07-14T07:00:00.000Z",
      nextPaid: true,
    },
    packageOffer: {
      exam: false,
      label: "",
      lessons: 4,
      amountKopecks: 600000,
      perLessonKopecks: 150000,
      savingsKopecks: 0,
      savingsPercent: 0,
      payLink: "https://yookassa.test/ahead",
    },
  };
  await mockApi(page, { my });
  await page.goto(tokenUrl());

  await expect(page.locator(".panel-when")).toContainText("оплачено");
  const pay = page.locator(".pay-card");
  await expect(pay.locator(".pay-ok")).toContainText("Ближайшее занятие оплачено");
  await expect(pay).toContainText("Оплачено вперёд: 1 занятие, до Вт, 14 июля включительно");
  await expect(pay).toContainText("платить сейчас ничего не нужно");
  // Оплатить дальше вперёд можно, но это предложение, а не счёт.
  const ahead = pay.locator(".pay-opt.ahead");
  await expect(ahead).toContainText("Оплатить вперёд · 4 занятия");
  await expect(ahead).toContainText("По желанию");
  await expect(pay.locator(".pay-total")).toHaveCount(0);
});

test("экзамен ЕГЭ в режиме СБП: реквизиты вместо ссылок оплаты", async ({ page }) => {
  const my = {
    ...MY_EGE,
    payHint: "Перевод по СБП на номер 8 927 750-23-78 (Т-Банк или Сбер)",
    payments: [{ ...MY_EGE.payments[0], payLink: "" }],
    packageOffer: { ...MY_EGE.packageOffer, payLink: "" },
  };
  await mockApi(page, { my });
  await page.goto(tokenUrl());
  const pay = page.locator(".pay-card");
  await expect(pay.getByText("Перевод по СБП на номер")).toBeVisible();
  await expect(pay.locator(".pay-btn")).toHaveCount(0);
});

test("без подтверждённых занятий: Телемост, пакет и счета скрыты", async ({ page }) => {
  const my = {
    events: [
      {
        id: "p1",
        student: "Тестовый Егор",
        subject: "ЕГЭ информатика",
        status: "pending", // только заявка — подтверждённых занятий нет
        start: "2026-07-14T07:00:00.000Z",
        recurring: true,
        weeks: 26,
        lessons: 1,
        moved: false,
        origStart: "",
      },
    ],
    payments: [{ id: "adv", amountKopecks: 250000, note: "x", payLink: "https://y/l", kind: "advance" }],
    balance: null,
    meetLink: "https://telemost.yandex.ru/j/e2e",
    payHint: "",
      packageOffer: MY_EGE.packageOffer,
    nextLesson: "2026-07-14T07:00:00.000Z",
  };
  await mockApi(page, { my });
  await page.goto(tokenUrl());

  await expect(page.getByText("ждёт подтверждения")).toBeVisible();
  // Ничего «занятийного» — Телемост, пакет, счета, ближайшее занятие скрыты.
  await expect(page.locator("a.panel-join")).toHaveCount(0);
  await expect(page.locator(".pay-card")).toHaveCount(0);
  await expect(page.getByText("К оплате")).toHaveCount(0);
  await expect(page.getByText("Ближайшее занятие")).toHaveCount(0);
  // Подключение уведомлений — тоже «занятийное»: пока занятие не подтверждено,
  // предлагать ученику подписку не на что.
  await expect(page.locator("a.panel-tg")).toHaveCount(0);
});

test("уведомления в Telegram: кнопка ведёт на бота с deep-link ученика", async ({ page }) => {
  const my = {
    ...MY_FULL,
    tgNotify: { url: "https://t.me/zapis_test_bot?start=stu-1", connected: false },
  };
  await mockApi(page, { my });
  await page.goto(tokenUrl());

  const btn = page.locator("a.panel-tg");
  await expect(btn).toContainText("Подключить уведомления в Telegram");
  await expect(btn).toContainText("Откроется бот");
  await expect(btn).toContainText("ссылку на Телемост");
  await expect(btn).toHaveAttribute("href", "https://t.me/zapis_test_bot?start=stu-1");
});

test("уведомления уже подключены — вместо кнопки статус", async ({ page }) => {
  const my = {
    ...MY_FULL,
    tgNotify: { url: "https://t.me/zapis_test_bot?start=stu-1", connected: true },
  };
  await mockApi(page, { my });
  await page.goto(tokenUrl());

  await expect(page.locator(".panel-tg.on")).toContainText("Уведомления в Telegram подключены");
  await expect(page.locator("a.panel-tg")).toHaveCount(0);
});

test("нет «25-го кадра»: пока /api/my грузится — спиннер, сетка не мелькает", async ({ page }) => {
  await mockApi(page, { my: MY_FULL, myDelayMs: 800 });
  await page.goto(tokenUrl());

  // Пока ответа нет: спиннер есть, сетки нет.
  await expect(page.locator(".spinner")).toBeVisible();
  await expect(page.locator(".slots-grid")).toHaveCount(0);

  // После ответа — кабинет (и по-прежнему без сетки).
  await expect(page.getByText("Ваши записи")).toBeVisible();
  await expect(page.locator(".slots-grid")).toHaveCount(0);
});

test("на телефоне записи показываются выше блока оплаты", async ({ page }) => {
  // Расписание ученику главнее счёта. На широком экране это две колонки (записи
  // слева, деньги справа), а в одну колонку они складываются именно в таком порядке.
  await page.setViewportSize({ width: 390, height: 800 });
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());
  const records = await page.locator(".my-card", { hasText: "Ваши записи" }).boundingBox();
  const pay = await page.locator(".pay-card").boundingBox();
  expect(records!.y).toBeLessThan(pay!.y);
});

test("панель переноса раскрывается под своей записью и видна на экране", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 }); // невысокий экран телефона
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());

  await page.getByRole("button", { name: "Перенести" }).click();
  // Панель — внутри карточки записей, а не под всеми карточками страницы.
  const panel = page.locator(".my-item .reschedule-bar");
  await expect(panel).toContainText("Переносим");

  // И она в пределах вьюпорта: страницу к ней подкручивает сам кабинет.
  const box = await panel.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(700);
});

test("перенос серии: выбор «одно занятие / каждую неделю», затем даты", async ({ page }) => {
  await mockApi(page, { my: MY_FULL });
  const slotUrls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/slots")) slotUrls.push(r.url());
  });
  const posted: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/reschedule")) posted.push(r.postData() || "");
  });
  await page.goto(tokenUrl());

  await page.getByRole("button", { name: "Перенести" }).click();
  await expect(page.locator(".reschedule-bar")).toContainText("Переносим");

  await page.getByRole("button", { name: "Только одно занятие" }).click();
  await expect(page.getByText("Какое занятие переносим?")).toBeVisible();
  // Даты приходят из /api/occurrences (замокан): два ближайших вторника.
  await expect(page.locator(".choice-row .mini")).toHaveCount(3); // 2 даты + «Закрыть»

  // Выбор даты открывает сетку для нового времени. Берём ВТОРУЮ дату (21 июля) —
  // на ней видно, что неделю подставляет сервер, а не клиент.
  await page.locator(".choice-row .mini").nth(1).click();
  await expect(page.getByText("Выберите новое время ниже для переноса.")).toBeVisible();
  await expect(page.locator(".slots-grid")).toBeVisible();

  // Сетка перезапрошена под неделю выбранного занятия: двигаем один час — и
  // занятость проверяется только на его дату, а не на месяц вперёд.
  await expect.poll(() => slotUrls.at(-1)).toContain("occ=2026-07-21T07%3A00%3A00.000Z");

  // Слот сетки уходит в перенос как есть: сдвиг в нужную неделю уже сделан на
  // сервере (замоканная сетка отдаёт свои даты — их и ждём). Раньше клиент двигал
  // время сам, и оно расходилось с тем, по чему проверялась занятость.
  await page.locator(".slot:not(.busy)").first().click();
  await expect.poll(() => posted.at(-1)).toContain('"start":"2026-07-14T07:00:00.000Z"');
});

test("«Записаться на другое время» открывает сетку у ученика с записями", async ({ page }) => {
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());
  await expect(page.locator(".slots-grid")).toHaveCount(0);
  await page.getByRole("button", { name: "Записаться на другое время" }).click();
  await expect(page.locator(".slots-grid")).toBeVisible();
});

// Кабинет участника группы — «панель», а не страница записи: время общее на всех,
// и один ученик не может ни выбрать его, ни подвинуть.
// Разовый перенос: сетка по умолчанию показывает неделю ПЕРЕНОСИМОГО занятия. Выбор
// текущей недели в календаре раньше просто возвращал ученика на неделю занятия — дата
// текущей недели не записывалась вовсе, потому что «обычная сетка и так её показывает».
test("перенос: текущая неделя открывается из календаря", async ({ page }) => {
  // Фиксируем «сегодня»: среда 15 июля 2026, 12:00 МСК. Текущая неделя — 13–19 июля,
  // а двигаем занятие 21 июля, то есть со следующей.
  await page.clock.setFixedTime(new Date("2026-07-15T09:00:00.000Z"));
  const slotUrls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/slots")) slotUrls.push(r.url());
  });
  // Настоящая сетка всегда содержит все семь дней (выходные — пустыми), поэтому и
  // в тесте берём полную неделю: активным днём становится сам выбранный.
  await mockApi(page, { my: MY_FULL, slots: SLOTS_WEEK });
  await page.goto(tokenUrl());

  await page.getByRole("button", { name: "Перенести" }).click();
  await page.getByRole("button", { name: "Только одно занятие" }).click();
  await page.getByRole("button", { name: "Вт, 21 июля" }).click();
  await expect.poll(() => slotUrls.at(-1)).toContain("occ=");

  await page.getByRole("button", { name: "Другая дата" }).click();
  await expect(page.locator(".cal-grid")).toBeVisible();
  // Четверг 16 июля — рабочий день текущей недели.
  await page.locator(".cal-day", { hasText: /^16$/ }).click();

  await expect(page.locator(".cal-grid")).toHaveCount(0);
  await expect(page.locator(".week-label")).toContainText("13–19 июля");
  // Неделя занятия больше не навязывается: в запросе обе части — какое занятие
  // двигаем и какую неделю показать.
  await expect.poll(() => slotUrls.at(-1)).toContain("from=");
  expect(slotUrls.at(-1)).toContain("occ=");
});

test("группа: состав, оплата и «Не смогу прийти» вместо переноса", async ({ page }) => {
  await mockApi(page, { my: MY_GROUP });
  await page.goto(tokenUrl());

  // Шапка кабинета группы — своя карточка вместо общего приветствия.
  const head = page.locator(".panel-head");
  await expect(head).toContainText("ОГЭ, суббота");
  await expect(head).toContainText("Групповые занятия · 3 участника");
  // Сетки записи нет вовсе — ни сразу, ни кнопкой «записаться ещё».
  await expect(page.locator(".slots-grid")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Записаться на другое время" })).toHaveCount(0);

  // Ближайшее занятие — карточкой: дата, повтор и ссылка на занятие.
  await expect(page.locator(".panel-when")).toContainText("18 июля");
  await expect(page.locator(".panel-sub")).toContainText("каждую субботу");
  await expect(page.locator("a.panel-join")).toHaveAttribute(
    "href",
    "https://telemost.yandex.ru/j/group"
  );

  // Расписание — конкретными датами, с оплатой по каждому занятию.
  const rows = page.locator(".my-card .my-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("25 июля");
  await expect(rows.nth(1)).toContainText("не оплачено");

  // Состав — только имена, плюс свободные места.
  const group = page.locator(".group-card");
  await expect(group).toContainText("Дима");
  await expect(group).toContainText("Злата");
  await expect(group).toContainText("1 место свободно");

  // Управлять общим занятием ученик не может.
  const row = rows.nth(1);
  await expect(row.getByRole("button", { name: "Перенести" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Отменить" })).toHaveCount(0);

  // Единственное действие — предупредить преподавателя, причём про ТУ дату, на
  // которой нажали: у серии свой start (первое занятие), и он тут ни при чём.
  const posted: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/absence")) posted.push(r.postData() || "");
  });
  page.on("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Не смогу прийти" }).click();
  await expect.poll(() => posted.at(-1)).toContain('"start":"2026-07-25T13:00:00.000Z"');
  await expect(row.getByRole("button", { name: "Предупредили" })).toBeDisabled();
  // Соседние даты остаются доступными — предупреждение относится к одной из них.
  await expect(rows.first().getByRole("button", { name: "Не смогу прийти" })).toBeEnabled();

  // Деньги остаются персональными — по цене группы.
  await expect(page.locator(".pay-card")).toContainText("750 ₽");
});
