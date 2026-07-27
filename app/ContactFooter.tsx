import { TEACHER_TG, teacherTgUrl } from "@/lib/config";

// Подпись «связаться с преподавателем» внизу любой страницы ученика. Нужна прежде
// всего там, где ученик сам ничего сделать не может: истёкшая/битая ссылка, заявка
// висит неподтверждённой, вопрос по счёту. Пишем в Telegram — уведомления ученикам
// из бота отключены, и это единственный канал связи в один тап.
export default function ContactFooter() {
  if (!TEACHER_TG) return null;
  return (
    <p className="contact">
      Вопрос преподавателю —{" "}
      <a href={teacherTgUrl()} target="_blank" rel="noreferrer">
        @{TEACHER_TG}
      </a>{" "}
      в Telegram
    </p>
  );
}
