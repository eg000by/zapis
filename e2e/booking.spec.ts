// Поток записи: сетка → выбор слотов → форма подтверждения → успех.
import { expect, test } from "@playwright/test";
import { mockApi, SLOTS_WEEK, tokenUrl } from "./helpers";

test("битая ссылка — вежливый экран без сетки, но со связью с преподавателем", async ({ page }) => {
  await mockApi(page);
  await page.goto("/?t=мусор");
  await expect(page.getByText("Похоже, ссылка неполная или неверная.")).toBeVisible();
  await expect(page.locator(".slots-grid")).toHaveCount(0);
  // Сам ученик тут ничего сделать не может — контакт преподавателя обязателен,
  // и он прямо в тексте («попросите преподавателя @eg0by…»), без второй подписи.
  await expect(page.getByRole("link", { name: "@eg0by" })).toHaveAttribute(
    "href",
    "https://t.me/eg0by"
  );
  await expect(page.locator(".contact")).toHaveCount(0);
});

test("контакт преподавателя есть и на обычном экране записи", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl());
  await expect(page.locator(".contact")).toContainText("@eg0by");
});

test("логотип Egorii.crm — только в подвале, в шапке его нет", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl());
  const logo = page.getByRole("img", { name: "Egorii.crm" });
  await expect(logo).toHaveCount(1);
  // Знак — монограмма «E» в фирменном flame-квадрате.
  await expect(logo.locator(".logo-mark")).toHaveText("E");
  await expect(logo.locator(".logo-mark")).toHaveCSS("background-color", "rgb(255, 58, 29)");

  // Логотип ниже приветствия и ниже сетки — внимание он не перехватывает.
  const hero = await page.locator(".hero h1").boundingBox();
  const grid = await page.locator(".slots-grid").boundingBox();
  const box = await logo.boundingBox();
  expect(box!.y).toBeGreaterThan(hero!.y);
  expect(box!.y).toBeGreaterThan(grid!.y + grid!.height);
});

test("сетка: приветствие, свободные и занятые слоты", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl());
  await expect(page.getByRole("heading", { name: /Здравствуйте, Егор/ })).toBeVisible();
  await expect(page.getByText("Выберите удобное время для занятий")).toBeVisible();
  await expect(page.locator(".slot", { hasText: "10:00" }).first()).toBeEnabled();
  await expect(page.locator(".slot.busy", { hasText: "11:10" })).toContainText("занято");
});

test("в сетке видна конкретная дата — в чипе дня и в заголовке", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl());
  // Первый слот вторника — 14 июля 2026.
  await expect(page.locator(".day-chip", { hasText: "Вт" }).locator("small")).toHaveText("14.07");
  await expect(page.locator(".card .day-title").first()).toContainText("14 июля");
});

test("выходной день: чип серый, слотов нет, вместо сетки — пояснение", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl());

  const friday = page.locator(".day-chip", { hasText: "Пт" });
  await expect(friday).toHaveClass(/closed/);

  await friday.click();
  await expect(page.getByText("Выходной — в этот день занятий нет")).toBeVisible();
  await expect(page.locator(".slots-grid")).toHaveCount(0);
});

test("мобилка: все 7 дней недели видны и помещаются по ширине", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 }); // типичный телефон
  await mockApi(page, { slots: SLOTS_WEEK });
  await page.goto(tokenUrl());

  const chips = page.locator(".day-nav .day-chip");
  await expect(chips).toHaveCount(7);
  // Воскресенье (последний чип) должно быть в пределах вьюпорта — не уезжать за край.
  const last = await chips.nth(6).boundingBox();
  expect(last).not.toBeNull();
  expect(last!.x + last!.width).toBeLessThanOrEqual(360);
  await expect(chips.nth(6)).toBeVisible();

  // Дата внутри чипа тоже должна помещаться: «14 июл» вылезал за края ячейки.
  const overflow = await chips.evaluateAll((els) =>
    els.filter((el) => el.scrollWidth > el.clientWidth + 1).length
  );
  expect(overflow).toBe(0);
});

// «Другая дата»: сетка по умолчанию показывает ближайшие дни, а календарь
// позволяет уехать на любую неделю в пределах горизонта — не усложняя саму сетку.
test("календарь: выбор даты переводит сетку на её неделю", async ({ page }) => {
  await mockApi(page, { slots: SLOTS_WEEK });
  const slotUrls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/slots")) slotUrls.push(r.url());
  });
  await page.goto(tokenUrl());
  await expect(page.locator(".slots-grid")).toBeVisible();
  // По умолчанию — ближайшие дни, без параметров недели.
  await expect(page.locator(".week-label")).toContainText("Ближайшие дни");
  expect(slotUrls.at(-1)).not.toContain("from=");

  await page.getByRole("button", { name: "Другая дата" }).click();
  await expect(page.locator(".cal-grid")).toBeVisible();
  // Прошедшие даты и выходные выбрать нельзя.
  expect(await page.locator(".cal-day:disabled").count()).toBeGreaterThan(0);

  // Листаем на следующий месяц и берём первый доступный день — так тест не зависит
  // от того, какое сегодня число.
  await page.getByRole("button", { name: "Следующий месяц" }).click();
  const day = page.locator(".cal-day:not([disabled])").first();
  const picked = (await day.textContent())!.trim();
  await day.click();

  // Календарь закрылся, сетка перезапрошена на неделю выбранной даты.
  await expect(page.locator(".cal-grid")).toHaveCount(0);
  await expect.poll(() => slotUrls.at(-1)).toContain("from=");
  await expect(page.locator(".week-label")).toContainText("Неделя");
  await expect(page.locator(".week-label")).toContainText(picked);

  // И обратно к ближайшей неделе — одной кнопкой.
  await page.getByRole("button", { name: "← Ближайшие" }).click();
  await expect(page.locator(".week-label")).toContainText("Ближайшие дни");
  await expect.poll(() => slotUrls.at(-1)).not.toContain("from=");
});

test("бронь: слот → «Записаться» → подтверждение → успех", async ({ page }) => {
  await mockApi(page);
  await page.goto(tokenUrl());

  await page.locator(".slot", { hasText: "10:00" }).first().click();
  await expect(page.locator(".picker-bar")).toContainText("Выбрано слотов: 1");
  await page.getByRole("button", { name: "Записаться →" }).click();

  // Форма подтверждения: конкретная дата первого занятия, пометка про повтор и цена.
  await expect(page.getByRole("heading", { name: "Подтверждение записи" })).toBeVisible();
  await expect(page.locator(".summary-row")).toContainText("Вт, 14 июля в 10:00 (МСК)");
  await expect(page.locator(".summary-tag")).toHaveText("далее еженедельно");
  await expect(page.locator(".sheet-price")).toContainText("1 занятие × 1 500 ₽ = 1 500 ₽ в неделю");

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
