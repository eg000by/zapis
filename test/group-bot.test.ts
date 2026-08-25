// callback_data у кнопок Telegram ограничена 64 БАЙТАМИ. Превышение — не усечение,
// а ошибка BUTTON_DATA_INVALID на всё сообщение: экран не открывается, кнопка молча
// «не работает», и видно это только в логах. Именно так сломалось добавление ученика
// в группу — там в кнопке лежали два uuid (81 байт). Проверяем сами кнопки.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyGroupInput,
  finishNewGroupStudent,
  promptNewGroupStudent,
  showAddMember,
  showGroupCard,
  showGroupMembers,
  showGroupsList,
} from "@/lib/group-bot";
import {
  CALLBACK_DATA_LIMIT,
  editMessageText,
  packUuid,
  sendOwner,
  unpackUuid,
} from "@/lib/telegram";
import { addToGroup, listGroupMembers, listGroups, getGroup } from "@/lib/groups";
import {
  getStudentByContactKey,
  listStudents,
  updateStudent,
  upsertStudent,
} from "@/lib/students";

vi.mock("@/lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram")>();
  return {
    ...actual,
    sendOwner: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/groups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/groups")>();
  return {
    ...actual,
    getGroup: vi.fn(),
    listGroups: vi.fn(async () => []),
    listGroupMembers: vi.fn(async () => []),
    addToGroup: vi.fn(async () => ({ ok: true, removedPersonal: 0 })),
  };
});
vi.mock("@/lib/students", () => ({
  listStudents: vi.fn(async () => []),
  getStudentByContactKey: vi.fn(async () => null),
  upsertStudent: vi.fn(async () => ({ id: "new-stu" })),
  updateStudent: vi.fn(async () => {}),
}));
// Состояние мастера держим в памяти: шаги идут друг за другом и читают его.
let state: { action: string; targetId: string } | null = null;
vi.mock("@/lib/botstate", () => ({
  getState: vi.fn(async () => state),
  setState: vi.fn(async (_c: string, action: string, targetId: string) => {
    state = { action, targetId };
  }),
  clearState: vi.fn(async () => {
    state = null;
  }),
}));
vi.mock("@/lib/google", () => ({
  CALENDAR_ID: "cal",
  calendarClient: vi.fn(),
  deleteFutureEventsForContact: vi.fn(async () => 0),
  fetchBusy: vi.fn(async () => []),
  lessonDescription: vi.fn(() => ""),
  nextOccurrenceForContact: vi.fn(async () => null),
}));
vi.mock("@/lib/shortlink", () => ({ getOrCreateStudentLinkCode: vi.fn(async () => "abc123") }));

// Настоящие uuid: на коротких id из тестов лимит не поймать — весь смысл в их длине.
const GID = "3f1a7c58-6b2e-4d9a-9e21-0c4b8d5f7a13";
const SID1 = "9c2d4e6f-1a3b-4c5d-8e7f-2b4a6c8d0e1f";
const SID2 = "b7e3d1c9-5f2a-4e8b-9d6c-3a1f7b5e2c4d";
const GROUP = {
  id: GID,
  name: "ОГЭ, суббота",
  subject: "ОГЭ информатика",
  contactKey: "gkey",
  rateKopecks: 75000,
  meetLink: "",
  active: true,
  note: "",
};

// Все callback_data из последнего отправленного экрана.
function lastButtons(): { text: string; callback_data: string }[] {
  const calls = vi.mocked(editMessageText).mock.calls;
  const markup = calls[calls.length - 1]?.[3] as { inline_keyboard: any[][] } | undefined;
  return (markup?.inline_keyboard || []).flat();
}

beforeEach(() => {
  vi.clearAllMocks();
  state = null;
  // clearAllMocks стирает вызовы, но не реализации — возвращаем значения по умолчанию,
  // иначе список участников из соседнего теста «протекает» в следующий.
  vi.mocked(listGroupMembers).mockResolvedValue([]);
  vi.mocked(listStudents).mockResolvedValue([]);
  vi.mocked(getStudentByContactKey).mockResolvedValue(null);
  vi.mocked(upsertStudent).mockResolvedValue({ id: "new-stu" } as any);
  vi.mocked(addToGroup).mockResolvedValue({ ok: true, removedPersonal: 0 } as any);
  vi.mocked(getGroup).mockResolvedValue(GROUP as any);
  vi.mocked(listGroups).mockResolvedValue([GROUP] as any);
});

describe("packUuid — uuid в 22 символа и обратно", () => {
  it("упакованный uuid короче исходного и распаковывается точно", () => {
    const packed = packUuid(GID);
    expect(packed).toHaveLength(22);
    expect(unpackUuid(packed)).toBe(GID);
  });

  it("пара упакованных id вместе с префиксом влезает в лимит", () => {
    const data = `grpjoin:${packUuid(GID)}:${packUuid(SID1)}`;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    // А так выглядела сломанная кнопка — 81 байт.
    expect(Buffer.byteLength(`grpjoin:${GID}:${SID1}`)).toBeGreaterThan(CALLBACK_DATA_LIMIT);
  });

  it("не-uuid проходит насквозь в обе стороны", () => {
    expect(packUuid("stu-1")).toBe("stu-1");
    expect(unpackUuid("stu-1")).toBe("stu-1");
    expect(unpackUuid("grp-1")).toBe("grp-1");
  });
});

describe("экраны групп — кнопки в пределах лимита", () => {
  it("список групп", async () => {
    await showGroupsList(1, 10);
    for (const b of lastButtons()) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
  });

  it("карточка группы", async () => {
    await showGroupCard(1, 10, GID);
    for (const b of lastButtons()) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
  });

  it("участники: «убрать» несёт ученика и группу", async () => {
    vi.mocked(listGroupMembers).mockResolvedValue([
      { id: SID1, name: "Дима", active: true },
      { id: SID2, name: "Злата", active: true },
    ] as any);
    await showGroupMembers(1, 10, GID);
    const buttons = lastButtons();
    for (const b of buttons) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
    // И распаковка возвращает те же id, что положили (иначе роутер уберёт не того).
    const kick = buttons.find((b) => b.callback_data.startsWith("grpkick:"))!;
    const [studentId, groupId] = kick.callback_data.slice(8).split(":").map(unpackUuid);
    expect(studentId).toBe(SID1);
    expect(groupId).toBe(GID);
  });

  it("некого добавить — экран объясняет, почему список пуст", async () => {
    vi.mocked(listStudents).mockResolvedValue([
      { id: SID1, name: "Дима", subject: "ОГЭ", active: false, trial: false, groupId: null },
      { id: SID2, name: "Гость", subject: "ОГЭ", active: true, trial: true, groupId: null },
    ] as any);
    await showAddMember(1, 10, GID);
    const text = String(vi.mocked(editMessageText).mock.calls.at(-1)?.[2]);
    expect(text).toContain("в архиве — 1");
    expect(text).toContain("пробных — 1");
    // Главное — что делать дальше: архив чинится в «Учениках», а не здесь.
    expect(text).toContain("из архива");
  });

  it("кого добавить: кнопка ученика влезает и распаковывается", async () => {
    vi.mocked(listStudents).mockResolvedValue([
      { id: SID2, name: "Злата", subject: "ОГЭ информатика", active: true, trial: false, groupId: null },
    ] as any);
    await showAddMember(1, 10, GID);
    const buttons = lastButtons();
    for (const b of buttons) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
    const join = buttons.find((b) => b.callback_data.startsWith("grpjoin:"))!;
    const [groupId, studentId] = join.callback_data.slice(8).split(":").map(unpackUuid);
    expect(groupId).toBe(GID);
    expect(studentId).toBe(SID2);
  });
});

// Ученика в группе заводят прямо из неё: предмет и цена уже заданы группой, и
// спрашивать их второй раз (а потом ещё раз добавлять ученика в группу) незачем.
describe("новый ученик прямо в группе", () => {
  it("спрашивает только имя, потом телеграм", async () => {
    await promptNewGroupStudent(1, GID);
    expect(state?.action).toBe("grp.stu.name");
    expect(state?.targetId).toBe(GID);
    const ask = String(vi.mocked(sendOwner).mock.calls.at(-1)?.[0]);
    // Предмет и цену показываем как уже известные, а не спрашиваем.
    expect(ask).toContain("ОГЭ информатика");
    expect(ask).toContain("750 ₽ за занятие");
    expect(ask).toContain("Пришлите имя");

    const handled = await applyGroupInput(1, "grp.stu.name", GID, " Матвей ");
    expect(handled).toBe(true);
    expect(state?.action).toBe("grp.stu.tg");
    expect(JSON.parse(state!.targetId)).toEqual({ g: GID, name: "Матвей" });
  });

  it("создаёт ученика по предмету группы и сразу кладёт в неё", async () => {
    await promptNewGroupStudent(1, GID);
    await applyGroupInput(1, "grp.stu.name", GID, "Матвей");
    await applyGroupInput(1, "grp.stu.tg", state!.targetId, "matvey");

    expect(vi.mocked(upsertStudent).mock.calls[0][0]).toMatchObject({
      name: "Матвей",
      subject: "ОГЭ информатика",
      tg: "@matvey", // собачку дописываем сами
      trial: false,
    });
    // Личная ставка нулевая: платит по цене группы, а тарифная ставка предмета
    // выглядела бы как индивидуальная цена, о которой не договаривались.
    expect(vi.mocked(updateStudent)).toHaveBeenCalledWith("new-stu", { rateKopecks: 0 });
    expect(vi.mocked(addToGroup)).toHaveBeenCalledWith("new-stu", GID);
    expect(state).toBeNull();
  });

  it("«Пропустить» телеграм — ученик всё равно создаётся", async () => {
    await promptNewGroupStudent(1, GID);
    await applyGroupInput(1, "grp.stu.name", GID, "Платон");
    await finishNewGroupStudent(1, "");
    expect(vi.mocked(upsertStudent).mock.calls[0][0]).toMatchObject({ name: "Платон", tg: "" });
    expect(vi.mocked(addToGroup)).toHaveBeenCalled();
  });

  it("в полную группу не пускает и мастер не начинает", async () => {
    vi.mocked(listGroupMembers).mockResolvedValue([
      { id: SID1, name: "а", active: true },
      { id: SID2, name: "б", active: true },
      { id: GID, name: "в", active: true },
      { id: "d0f1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b", name: "г", active: true },
    ] as any);
    await promptNewGroupStudent(1, GID);
    expect(state).toBeNull();
    expect(String(vi.mocked(sendOwner).mock.calls.at(-1)?.[0])).toContain("уже 4 человек");
  });

  it("уже заведённого ученика не плодит, а из архива возвращает", async () => {
    vi.mocked(getStudentByContactKey).mockResolvedValue({
      id: "old-stu",
      active: false,
      rateKopecks: 150000,
    } as any);
    vi.mocked(upsertStudent).mockResolvedValue({ id: "old-stu" } as any);
    await promptNewGroupStudent(1, GID);
    await applyGroupInput(1, "grp.stu.name", GID, "Дима");
    await finishNewGroupStudent(1, "");
    // Архив снимаем — иначе ученик попал бы в группу и остался невидимым в списке.
    expect(vi.mocked(updateStudent)).toHaveBeenCalledWith("old-stu", { active: true });
    // А личную ставку не обнуляем: она пригодится, когда он выйдет из группы.
    expect(vi.mocked(updateStudent)).not.toHaveBeenCalledWith("old-stu", { rateKopecks: 0 });
    expect(vi.mocked(addToGroup)).toHaveBeenCalledWith("old-stu", GID);
    // Последним уходит экран участников, а сообщение об итоге — перед ним.
    expect(String(vi.mocked(sendOwner).mock.calls.at(-2)?.[0])).toContain("возвращён из архива");
  });

  it("сессия истекла — ученик не создаётся", async () => {
    state = null;
    await finishNewGroupStudent(1, "@кто-то");
    expect(vi.mocked(upsertStudent)).not.toHaveBeenCalled();
  });
});
