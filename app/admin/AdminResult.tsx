"use client";

import { useState } from "react";

export default function AdminResult({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* игнорируем — можно скопировать вручную */
    }
  }

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <label style={{ marginTop: 0 }}>Персональная ссылка</label>
      <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
      <button className="btn" onClick={copy}>
        {copied ? "Скопировано ✓" : "Скопировать ссылку"}
      </button>
      <p className="hint">Отправьте эту ссылку ученику. Имя и Telegram уже зашиты в неё.</p>
    </div>
  );
}
