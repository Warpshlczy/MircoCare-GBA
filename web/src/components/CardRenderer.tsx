"use client";

import type { AgentCard, CardData, Intent } from "@/lib/types";

/**
 * Renders ONE agent card. Two modes:
 *  - `card.data` → frontend-rendered structured card (safe, no HTML).
 *  - `card.html` → backend-agent-rendered HTML inside a sandboxed iframe with
 *    `sandbox=""` (scripts, forms and navigation all disabled). This is the
 *    security boundary: untrusted agent HTML never gets script access.
 */
export function CardRenderer({ card, onAction }: { card: AgentCard; onAction?: (intent: Intent) => void }) {
  return (
    <article
      aria-label={card.title}
      className="w-full rounded-[2rem] bg-white p-6 shadow-md hc:border hc:border-white hc:bg-black"
    >
      <div className="flex items-center gap-3">
        {card.data?.icon ? <span className="text-5xl" aria-hidden>{card.data.icon}</span> : null}
        <h2 className="text-3xl font-extrabold text-aura-deep hc:text-white">{card.title}</h2>
      </div>

      {card.html ? (
        <iframe
          title={card.title}
          sandbox=""
          srcDoc={card.html}
          className="mt-4 h-72 w-full rounded-2xl border-0 bg-white"
        />
      ) : card.data ? (
        <CardBody data={card.data} />
      ) : null}

      {card.actions?.length ? (
        <div className="mt-5 flex flex-col gap-3">
          {card.actions.map((a) => (
            <button
              key={a.id}
              onClick={() => onAction?.(a.intent)}
              className="rounded-2xl bg-aura-accent px-6 py-5 text-3xl font-bold text-white"
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function CardBody({ data }: { data: CardData }) {
  return (
    <div className="mt-3">
      {data.image ? (
        <img src={data.image} alt="" className="mb-4 w-full rounded-2xl" />
      ) : null}

      {data.headline ? (
        <p className="break-words text-4xl font-black text-aura-deep hc:text-yellow-300">{data.headline}</p>
      ) : null}

      {data.rows?.length ? (
        <dl className="mt-3 grid grid-cols-2 gap-2">
          {data.rows.map((r) => (
            <div key={r.label}>
              <dt className="text-2xl font-bold text-aura-ink hc:text-yellow-300">{r.label}</dt>
              <dd className="text-3xl font-semibold text-aura-deep hc:text-white">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {data.checklist?.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {data.checklist.map((it) => (
            <li key={it.id} className="flex items-center gap-3 text-3xl font-semibold text-aura-deep hc:text-white">
              <span aria-hidden className="text-4xl">{it.done ? "☑️" : "⬜"}</span>
              <span className={it.done ? "line-through opacity-60" : ""}>{it.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}