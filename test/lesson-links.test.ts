// Постоянные ссылки занятия — звонок и рабочая доска. Они ходят парой: в кабинете,
// в напоминаниях и в описании события календаря. Здесь проверяется именно пара —
// правка одной ссылки не должна стирать другую, а это ровно то, что легко сломать:
// описание события пересобирается целиком.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStored, resetCalendar, seedEvent } from "./helpers/fake-google";

vi.mock("googleapis", async () => {
  const { google } = await import("./helpers/fake-google");
  return { google, calendar_v3: {} };
});

const KEY = "contact-key-1";
const MEET = "https://telemost.yandex.ru/j/777";
const BOARD = "https://unidraw.io/app/board/d4672b11f63cbaf061f9";

function seed(priv: Record<string, string>, description = "") {
  return seedEvent({
    summary: "Стас — Питон",
    description,
    start: { dateTime: "2026-07-20T06:00:00.000Z" },
    end: { dateTime: "2026-07-20T07:00:00.000Z" },
    extendedProperties: { private: { app: "zapis", contactKey: KEY, status: "confirmed", ...priv } },
  } as any).id;
}

beforeEach(() => {
  vi.setSystemTime(new Date("2026-07-12T09:00:00.000Z"));
  resetCalendar();
});

describe("lessonDescription", () => {
  it("обе ссылки — отдельными строками", async () => {
    const { lessonDescription } = await import("@/lib/google");
    const d = lessonDescription({
      student: "Стас",
      subject: "Питон",
      recurring: true,
      confirmed: true,
      meetLink: MEET,
      boardLink: BOARD,
    });
    expect(d).toContain(`Телемост: ${MEET}`);
    expect(d).toContain(`Доска: ${BOARD}`);
  });

  it("незаданная ссылка строку не занимает", async () => {
    const { lessonDescription } = await import("@/lib/google");
    const d = lessonDescription({
      student: "Стас",
      subject: "Питон",
      recurring: false,
      confirmed: true,
      meetLink: MEET,
    });
    expect(d).toContain("Телемост:");
    expect(d).not.toContain("Доска:");
  });
});

describe("applyLinksToEvents", () => {
  it("пишет обе ссылки в описание подтверждённого занятия", async () => {
    const { applyLinksToEvents } = await import("@/lib/google");
    const id = seed({ student: "Стас", subject: "Питон" });

    expect(await applyLinksToEvents(KEY, { meetLink: MEET, boardLink: BOARD })).toBe(1);
    const d = getStored(id)!.description || "";
    expect(d).toContain(`Телемост: ${MEET}`);
    expect(d).toContain(`Доска: ${BOARD}`);
  });

  it("смена одной ссылки не стирает другую", async () => {
    const { applyLinksToEvents } = await import("@/lib/google");
    const id = seed({ student: "Стас", subject: "Питон" });
    await applyLinksToEvents(KEY, { meetLink: MEET, boardLink: BOARD });

    const other = "https://telemost.yandex.ru/j/999";
    await applyLinksToEvents(KEY, { meetLink: other, boardLink: BOARD });
    const d = getStored(id)!.description || "";
    expect(d).toContain(`Телемост: ${other}`);
    expect(d).toContain(`Доска: ${BOARD}`);
    expect(d).not.toContain("j/777");
  });

  it("пустая ссылка убирает свою строку и не трогает соседнюю", async () => {
    const { applyLinksToEvents } = await import("@/lib/google");
    const id = seed({ student: "Стас", subject: "Питон" });
    await applyLinksToEvents(KEY, { meetLink: MEET, boardLink: BOARD });

    await applyLinksToEvents(KEY, { meetLink: MEET, boardLink: "" });
    const d = getStored(id)!.description || "";
    expect(d).toContain(`Телемост: ${MEET}`);
    expect(d).not.toContain("Доска:");
  });

  // Совсем старые события: данных ученика в extendedProperties нет, описание целиком
  // не пересобрать — правятся только строки ссылок, остальной текст остаётся.
  it("у старого события правит только строки ссылок", async () => {
    const { applyLinksToEvents } = await import("@/lib/google");
    const id = seed({}, "Занятие подтверждено.\nУченик: Стас\nТелемост: https://old\nДоска: https://old-board");

    await applyLinksToEvents(KEY, { meetLink: MEET, boardLink: BOARD });
    const d = getStored(id)!.description || "";
    expect(d).toContain("Ученик: Стас");
    expect(d).toContain(`Телемост: ${MEET}`);
    expect(d).toContain(`Доска: ${BOARD}`);
    expect(d).not.toContain("https://old");
  });

  it("неподтверждённую заявку не трогает", async () => {
    const { applyLinksToEvents } = await import("@/lib/google");
    const id = seedEvent({
      summary: "Стас — Питон",
      description: "Заявка через сайт записи (ожидает подтверждения).",
      start: { dateTime: "2026-07-20T06:00:00.000Z" },
      end: { dateTime: "2026-07-20T07:00:00.000Z" },
      extendedProperties: { private: { app: "zapis", contactKey: KEY, status: "pending" } },
    } as any).id;

    expect(await applyLinksToEvents(KEY, { meetLink: MEET, boardLink: BOARD })).toBe(0);
    expect(getStored(id)!.description).not.toContain("Доска:");
  });
});
