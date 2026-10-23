"use client";

import { useEffect, useState, type FormEvent } from "react";
import { t } from "@/lib/i18n";
import type { Locale, ReminderItem } from "@/lib/types";

interface Props {
  open: boolean;
  locale: Locale;
  onClose: () => void;
  onSave: (item: ReminderItem) => void;
}

function inputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Default: tomorrow 09:00 local — the most common clinic-slot assumption. */
function defaultWhen(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return inputValue(d);
}

/**
 * Large-type form for a follow-up / clinic appointment reminder. Reuses the
 * existing reminder scheduler (`kind: "followup"`), so no new storage or alert
 * machinery is needed. Voice entry opens this same form: dates are chosen with
 * a native picker instead of fragile speech-to-time parsing.
 */
export function FollowupSheet({ open, locale, onClose, onSave }: Props) {
  const [when, setWhen] = useState(defaultWhen);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setWhen(defaultWhen());
    setTitle(t(locale, "followupTitle"));
    setError("");
  }, [open, locale]);

  if (!open) return null;

  function submit(e: FormEvent) {
    e.preventDefault();
    const at = new Date(when).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) {
      setError(t(locale, "followupInvalid"));
      return;
    }
    const now = Date.now();
    onSave({
      id: `followup-${now}`,
      kind: "followup",
      title: title.trim() || t(locale, "followupTitle"),
      dueAt: at,
      status: "pending",
      stage: "none",
      createdAt: now,
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/50 sm:items-center sm:justify-center sm:p-6"
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="followup-form-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-lg rounded-t-[2rem] bg-white p-8 text-aura-deep sm:rounded-[2rem] hc:bg-black hc:text-white"
      >
        <h2 id="followup-form-title" className="text-4xl font-extrabold">
          {t(locale, "followupFormTitle")}
        </h2>

        <label className="mt-6 block text-2xl font-bold" htmlFor="followup-when">
          {t(locale, "followupFormWhen")}
        </label>
        <input
          id="followup-when"
          type="datetime-local"
          value={when}
          min={inputValue(new Date())}
          onChange={(e) => setWhen(e.target.value)}
          className="elderly-tap mt-2 w-full rounded-2xl border-4 border-aura-deep bg-aura-bg px-4 py-4 text-2xl font-bold text-aura-deep hc:border-white hc:bg-neutral-800 hc:text-white"
        />

        <label className="mt-5 block text-2xl font-bold" htmlFor="followup-title">
          {t(locale, "followupFormLabel")}
        </label>
        <input
          id="followup-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={40}
          className="elderly-tap mt-2 w-full rounded-2xl border-4 border-aura-deep bg-aura-bg px-4 py-4 text-2xl font-bold text-aura-deep hc:border-white hc:bg-neutral-800 hc:text-white"
        />

        {error ? (
          <p aria-live="assertive" className="mt-3 text-2xl font-bold text-aura-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-8 flex gap-4">
          <button
            type="submit"
            className="elderly-tap flex-1 rounded-2xl bg-aura-accent px-6 py-5 text-3xl font-extrabold text-white"
          >
            {t(locale, "followupSave")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="elderly-tap flex-1 rounded-2xl border-4 border-aura-deep bg-white px-6 py-5 text-3xl font-bold text-aura-deep hc:border-white hc:bg-black hc:text-white"
          >
            {t(locale, "cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}
