import { TEACHER_TG, teacherTgUrl } from "@/lib/config";
import { LogoInline } from "./Logo";

// Подвал страницы ученика: логотип и связь с преподавателем. Контакт нужен прежде
// всего там, где ученик сам ничего сделать не может: истёкшая/битая ссылка, заявка
// висит неподтверждённой, вопрос по счёту. Пишем в Telegram — уведомления ученикам
// из бота отключены, и это единственный канал связи в один тап.
//
// Логотип живёт только здесь: в шапке он спорил бы за внимание с расписанием и
// суммой к оплате, а внизу страницы подписывает сервис, ничего не перебивая.
export default function ContactFooter() {
  return (
    <footer className="site-footer">
      <LogoInline />
      {TEACHER_TG && (
        <p className="contact">
          Вопрос преподавателю —{" "}
          <a href={teacherTgUrl()} target="_blank" rel="noreferrer">
            @{TEACHER_TG}
          </a>{" "}
          в Telegram
        </p>
      )}
    </footer>
  );
}
