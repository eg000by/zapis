// Личный кабинет ученика с записями: плашки, счета, способ оплаты, отсутствие
// «25-го кадра» (сетка не мелькает, пока грузится /api/my).
import { expect, test } from "@playwright/test";
import { MY_FULL, mockApi, tokenUrl } from "./helpers";

test("кабинет: записи вместо сетки, все плашки на месте", async ({ page }) => {
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());

  // Сетки нет — есть кабинет.
  await expect(page.getByText("Ваши записи")).toBeVisible();
  await expect(page.locator(".slots-grid")).toHaveCount(0);

  // Плашки: ближайшее занятие, Телемост, уведомления в TG.
  await expect(page.getByText("Ближайшее занятие")).toBeVisible();
  const meet = page.locator("a.meet-link");
  await expect(meet).toContainText("Телемост");
  await expect(meet).toHaveAttribute("href", "https://telemost.yandex.ru/j/e2e");
  await expect(page.locator("a.tg-link")).toHaveAttribute(
    "href",
    "https://t.me/e2e_bot?start=stu-1"
  );

  // Баланс: долг за 1 занятие.
  await expect(page.locator(".balance-row.debt")).toContainText("Долг");

  // Запись: еженедельно, подтверждена, с кнопками управления.
  // (.my-row есть и в «К оплате» — берём строку именно записи.)
  const row = page.locator(".my-row", { hasText: "Тестовый Егор — Питон" });
  await expect(row).toContainText("еженедельно");
  await expect(row).toContainText("✅ подтверждено");
  await expect(row.getByRole("button", { name: "Перенести" })).toBeVisible();
});

test("счёт с ЮKassa: кнопка «Оплатить по СБП» со ссылкой", async ({ page }) => {
  await mockApi(page, { my: MY_FULL });
  await page.goto(tokenUrl());
  const pay = page.getByRole("link", { name: /Оплатить по СБП/ });
  await expect(pay).toHaveAttribute("href", "https://yookassa.test/pay");
});

test("режим «СБП-перевод»: реквизиты вместо кнопки оплаты", async ({ page }) => {
  const my = {
    ...MY_FULL,
    payHint: "Перевод по СБП на номер 8 927 750-23-78 (Т-Банк или Сбер)",
    payments: [{ ...MY_FULL.payments[0], payLink: "" }],
  };
  await mockApi(page, { my });
  await page.goto(tokenUrl());
  await expect(page.getByText("Перевод по СБП на номер")).toBeVisible();
  await expect(page.getByRole("link", { name: /Оплатить по СБП/ })).toHaveCount(0);
  await expect(page.getByText("ждём ссылку на оплату")).toHaveCount(0);
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
