// Личный кабинет ученика с записями: плашки, счета, способ оплаты, отсутствие
// «25-го кадра» (сетка не мелькает, пока грузится /api/my).
import { expect, test } from "@playwright/test";
import { MY_EGE, MY_FULL, mockApi, tokenUrl } from "./helpers";

test("кабинет: записи вместо сетки, все плашки на месте", async ({ page }) => {
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());

  // Сетки нет — есть кабинет, и подзаголовок это подтверждает.
  await expect(page.getByText("Ваши записи")).toBeVisible();
  await expect(page.locator(".slots-grid")).toHaveCount(0);
  await expect(page.locator(".hero p")).toContainText("Ваши занятия и оплата");
  await expect(page.locator(".hero p")).not.toContainText("Выберите удобное время");

  // Плашки: ближайшее занятие, Телемост.
  await expect(page.getByText("Ближайшее занятие")).toBeVisible();
  const meet = page.locator("a.meet-link");
  await expect(meet).toContainText("Телемост");
  await expect(meet).toHaveAttribute("href", "https://telemost.yandex.ru/j/e2e");
  // Кнопки «Подключить уведомления в Telegram» больше нет.
  await expect(page.locator("a.tg-link")).toHaveCount(0);

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
  const row = page.locator(".my-row", { hasText: "Тестовый Егор — Питон" });
  await expect(row).toContainText("еженедельно");
  await expect(row).toContainText("✅ подтверждено");
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
  await expect(opts.nth(0)).toContainText("Как сейчас");
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
  await expect(page.locator("a.meet-link")).toHaveCount(0);
  await expect(page.locator(".pay-card")).toHaveCount(0);
  await expect(page.getByText("К оплате")).toHaveCount(0);
  await expect(page.getByText("Ближайшее занятие")).toHaveCount(0);
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

test("перенос серии: выбор «одно занятие / каждую неделю», затем даты", async ({ page }) => {
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());

  await page.getByRole("button", { name: "Перенести" }).click();
  await expect(page.locator(".reschedule-bar")).toContainText("Переносим");

  await page.getByRole("button", { name: "📅 Только одно занятие" }).click();
  await expect(page.getByText("Какое занятие переносим?")).toBeVisible();
  // Даты приходят из /api/occurrences (замокан): два ближайших вторника.
  await expect(page.locator(".choice-row .mini")).toHaveCount(3); // 2 даты + «Закрыть»

  // Выбор даты открывает сетку для нового времени.
  await page.locator(".choice-row .mini").first().click();
  await expect(page.getByText("Выберите новое время ниже для переноса.")).toBeVisible();
  await expect(page.locator(".slots-grid")).toBeVisible();
});

test("«＋ Записаться на другое время» открывает сетку у ученика с записями", async ({ page }) => {
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());
  await expect(page.locator(".slots-grid")).toHaveCount(0);
  await page.getByRole("button", { name: "＋ Записаться на другое время" }).click();
  await expect(page.locator(".slots-grid")).toBeVisible();
});
