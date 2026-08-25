// Иконки интерфейса. Один компонент вместо эмодзи: эмодзи рисуются шрифтом системы
// (на каждой ОС свои, цветные и разного веса) — набор из них выглядит пёстро и
// по-детски. Здесь один штрих, один вес и currentColor, поэтому иконка всегда в цвет
// текста рядом и одинакова везде.
//
// Размер задаётся в em — иконка масштабируется вместе со строкой, в которой стоит.
// Только украшение: смысл несёт текст рядом, поэтому aria-hidden.

export type IconName =
  | "clock"
  | "video"
  | "check"
  | "checkCircle"
  | "calendar"
  | "repeat"
  | "trash"
  | "alert"
  | "card"
  | "bell"
  | "user"
  | "users"
  | "link"
  | "hourglass"
  | "inbox"
  | "moon"
  | "lock"
  | "chart"
  | "receipt"
  | "archive"
  | "target"
  | "ban"
  | "plus";

const PATHS: Record<IconName, JSX.Element> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.4 2" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="M16 10.5 21 8v8l-5-2.5z" />
    </>
  ),
  check: <path d="M4.5 12.5 9.5 17.5 19.5 7" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.3 10.9 15.2 16 9.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>
  ),
  repeat: (
    <>
      <path d="M4 11a8 8 0 0 1 13.3-6" />
      <path d="M20 13a8 8 0 0 1-13.3 6" />
      <path d="M17.5 1.8 17.8 5.4 14.2 5.6M6.5 22.2 6.2 18.6 9.8 18.4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9.5 7V4h5v3" />
      <path d="M6.5 7 7.6 20h8.8L17.5 7" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2 21 19.5H3z" />
      <path d="M12 10v4.2M12 17.1v.1" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M3 10.5h18" />
    </>
  ),
  bell: (
    <>
      <path d="M18 16.5v-5a6 6 0 1 0-12 0v5l-1.7 2h15.4z" />
      <path d="M10 21.2a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5.2 20a6.8 6.8 0 0 1 13.6 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8.5" r="3.2" />
      <path d="M3.5 20a6 6 0 0 1 12 0" />
      <path d="M16 6.2a3.2 3.2 0 0 1 0 5.9M17.5 15.2A6 6 0 0 1 20.5 20" />
    </>
  ),
  link: (
    <>
      <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.3-1.3" />
    </>
  ),
  hourglass: (
    <>
      <path d="M7 3h10M7 21h10" />
      <path d="M7 3v3.2l5 5.8 5-5.8V3M7 21v-3.2l5-5.8 5 5.8V21" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13.5h5l1.2 3h5.6l1.2-3h5" />
      <path d="M3 13.5 6 5h12l3 8.5V20H3z" />
    </>
  ),
  moon: <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a7 7 0 1 0 10.2 10.2z" />,
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20h16" />
      <path d="M6.5 20v-6M12 20V6M17.5 20v-9" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8z" />
      <path d="M9.5 8.5h5M9.5 12.5h5" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
      <path d="M5 8.5V20h14V8.5" />
      <path d="M10 12.5h4" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 11.9v.1" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 18 18 6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
};

export default function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={`ico ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
