// Логотип Egorii.crm — комплект 2a из дизайн-проекта: монограмма «E» в скруглённом
// квадрате и горизонтальная связка знака с названием.
//
// Пропорции взяты из комплекта и заданы от размера знака (--logo-size), чтобы связка
// одинаково собиралась в любом масштабе: радиус — 0.22 от стороны (56→12, 36→8, 22→5),
// буква — 0.54 (96→52, 56→30), зазор до текста — 0.21, «Egorii» — 0.42, «.crm» — 0.21.
// Цвета бренда — в CSS-переменных (--brand-*): на тёмной теме знак переключается на
// янтарный вариант «на тёмном фоне» из того же комплекта.

// Только знак — для мест, где название рядом уже написано (иконка, аватар, favicon).
export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <span className="logo-mark" style={{ ["--logo-size" as string]: `${size}px` }} aria-hidden="true">
      E
    </span>
  );
}

// Компактная связка для подвала: знак и название в одну строку, текст приглушён.
// В шапке логотипа нет намеренно — он не должен спорить за внимание с расписанием
// и суммой к оплате, поэтому «.crm» здесь набрано в строку, а не eyebrow'ом.
export function LogoInline({ size = 20 }: { size?: number }) {
  return (
    <span
      className="logo logo-inline"
      style={{ ["--logo-size" as string]: `${size}px` }}
      role="img"
      aria-label="Egorii.crm"
    >
      <span className="logo-mark" aria-hidden="true">
        E
      </span>
      <span className="logo-flat" aria-hidden="true">
        Egorii<span className="logo-dot">.</span>crm
      </span>
    </span>
  );
}

// Горизонтальная связка: знак + «Egorii» + «.crm» (курсив, капс, разрядка).
export default function Logo({ size = 36 }: { size?: number }) {
  return (
    <span className="logo" style={{ ["--logo-size" as string]: `${size}px` }} role="img" aria-label="Egorii.crm">
      <span className="logo-mark" aria-hidden="true">
        E
      </span>
      <span className="logo-text" aria-hidden="true">
        <span className="logo-name">Egorii</span>
        <span className="logo-suffix">.crm</span>
      </span>
    </span>
  );
}
