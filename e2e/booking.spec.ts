// Поток записи: сетка → выбор слотов → форма подтверждения → успех.
import { expect, test } from "@playwright/test";
import { mockApi, tokenUrl } from "./helpers";

test("битая ссылка — вежливый экран без сетки", async ({ page }) => {
  await mockApi(page);
  await page.goto("/?t=мусор");
  await expect(page.getByText("Похоже, ссылка неполная или неверная.")).toBeVisible();
  await expect(page.locator(".slots-grid")).toHaveCount(0);
});

test("сетка: приветствие, свободные и занятые слоты", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl());
  await expect(page.getByRole("heading", { name: /Здравствуйте, Егор/ })).toBeVisible();
  await expect(page.locator(".slot", { hasText: "10:00" }).first()).toBeEnabled();
  await expect(page.locator(".slot.busy", { hasText: "11:10" })).toContainText("занято");
});

test("бронь: слот → «Записаться» → подтверждение → успех", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl());

  await page.locator(".slot", { hasText: "10:00" }).first().click();
  await expect(page.locator(".picker-bar")).toContainText("Выбрано слотов: 1");
  await page.getByRole("button", { name: "Записаться →" }).click();

  // Форма подтверждения: слот и пометка «еженедельно».
  await expect(page.getByRole("heading", { name: "Подтверждение записи" })).toBeVisible();
  await expect(page.locator(".summary-row")).toContainText("Вторник, 14 июля, 10:00 (МСК)");
  await expect(page.locator(".summary-tag")).toHaveText("еженедельно");

  await page.locator(".sheet").getByRole("button", { name: /^Записаться/ }).click();
  await expect(page.getByRole("heading", { name: "Заявка отправлена!" })).toBeVisible();
});

test("два подряд часа схлопываются в один блок в подтверждении", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl());
  await page.locator(".slot", { hasText: "10:00" }).first().click();
  await page.locator(".slot", { hasText: "12:20" }).first().click();
  await expect(page.locator(".picker-bar")).toContainText("Выбрано слотов: 2");
  await page.getByRole("button", { name: "Записаться →" }).click();
  // Слоты не смежные (11:10 занято) — двумя строками.
  await expect(page.locator(".summary-row")).toHaveCount(2);
});

test("слот занят на сервере (409) — ошибка в форме, бронь не создаётся", async ({ page }) => {
  await mockApi(page, { book: { status: 409, body: { error: "Это время уже занято." } } });
  await page.goto(tokenUrl());
  await page.locator(".slot", { hasText: "10:00" }).first().click();
  await page.getByRole("button", { name: "Записаться →" }).click();
  await page.locator(".sheet").getByRole("button", { name: /^Записаться/ }).click();
  await expect(page.locator(".error-text")).toContainText("уже занято");
});

test("пробная ссылка: выбор одиночный — второй клик заменяет слот", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl({ trial: true }));
  await expect(page.getByText("Выберите время для пробного занятия")).toBeVisible();

  await page.locator(".slot", { hasText: "10:00" }).first().click();
  await page.locator(".slot", { hasText: "12:20" }).first().click();
  await expect(page.locator(".picker-bar")).toContainText("Выбрано слотов: 1");
  await expect(page.locator(".slot.picked")).toHaveText("12:20");

  await page.getByRole("button", { name: "Записаться →" }).click();
  await expect(page.locator(".summary-tag")).toHaveText("разово");
});
