"use client";

import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import type { AgentCard, Locale } from "@/lib/types";

interface Props {
  card: AgentCard | null;
  locale: Locale;
  onClose: () => void;
}

/**
 * Full-screen answer sheet for query results (weather, chat answers).
 *
 * The card comes first and covers the whole screen: the senior asked a question,
 * so the answer is the only thing to read. One oversized close button is the
 * only way out, and the assistant reads exactly the same words aloud (the
 * caller speaks `weatherSpoken()` / the reply before or while this opens).
 */
export function CardSheet({ card, locale, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const cardId = card?.id;

  useEffect(() => {
    if (!cardId) return;
    closeRef.current?.focus();
  }, [cardId]);

  if (!card) return null;
  const data = card.data;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sheet-title"
      className="fixed inset-0 z-[70] flex flex-col gap-6 overflow-y-auto bg-aura-bg p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] hc:bg-black"
    >
      <div className="flex items-center gap-4">
        {data?.icon ? (
          <span className="text-6xl" aria-hidden>
            {data.icon}
          </span>
        ) : null}
        <h2 id="sheet-title" className="text-4xl font-extrabold text-aura-deep hc:text-white">
          {card.title}
        </h2>
      </div>

      {card.html ? (
        <iframe
          title={card.title}
          sandbox=""
          srcDoc={card.html}
          className="min-h-72 w-full flex-1 rounded-2xl border-0 bg-white"
        />
      ) : null}

      {data?.image ? <img src={data.image} alt="" className="w-full rounded-3xl" /> : null}

      {data?.headline ? (
        <p
          className={`break-words font-black leading-snug text-aura-deep hc:text-yellow-300 ${
            // A weather headline is a few characters; a chat answer can be a
            // paragraph. Both stay far above the 24px floor without turning a
            // long answer into a scroll-only wall of 60px glyphs.
            data.headline.length > 40 ? "text-4xl" : "text-6xl"
          }`}
        >
          {data.headline}
        </p>
      ) : null}

      {data?.rows?.length ? (
        <dl className="flex flex-col gap-3">
          {data.rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-4 rounded-2xl bg-white px-5 py-4 shadow-sm hc:bg-neutral-900">
              <dt className="text-3xl font-bold text-aura-ink hc:text-yellow-300">{r.label}</dt>
              <dd className="text-4xl font-extrabold text-aura-deep hc:text-white">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {data?.checklist?.length ? (
        <ul className="flex flex-col gap-3">
          {data.checklist.map((it) => (
            <li key={it.id} className="flex items-center gap-3 text-4xl font-semibold text-aura-deep hc:text-white">
              <span aria-hidden className="text-5xl">
                {it.done ? "☑️" : "⬜"}
              </span>
              <span className={it.done ? "line-through opacity-60" : ""}>{it.text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <button
        ref={closeRef}
        onClick={onClose}
        className="sticky bottom-0 mt-auto min-h-[96px] w-full rounded-[2rem] bg-aura-deep px-6 py-6 text-5xl font-extrabold text-white shadow-[0_-8px_24px_rgba(0,0,0,0.18)] focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:bg-yellow-300 hc:text-black"
      >
        {t(locale, "sheetClose")}
      </button>
    </div>
  );
}
