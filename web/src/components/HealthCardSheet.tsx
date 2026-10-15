"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { t } from "@/lib/i18n";
import type { HealthCard, Locale } from "@/lib/types";

interface Props {
  open: boolean;
  card: HealthCard;
  locale: Locale;
  onClose: () => void;
}

// ponytail: qrcode@^1.5 is a deliberate dependency — a spec-correct QR encoder is
// ~200 lines of Reed–Solomon + masking bit-twiddling that nobody should hand-roll for
// a hackathon. Everything else here is browser-native.
/** Bottom-sheet cross-border health card (HK / Macao / Hengqin clinics) + QR. Print friendly. */
export function HealthCardSheet({ open, card, locale, onClose }: Props) {
  const [qr, setQr] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    // only the minimum a clinic needs; explicit consent, no national id
    const payload = JSON.stringify({
      v: 1,
      name: card.name,
      age: card.age,
      blood: card.bloodType,
      allergies: card.allergies,
      conditions: card.chronicConditions,
      meds: card.medications,
      ec: card.emergencyContact.phone,
    });
    QRCode.toDataURL(payload, { margin: 1, width: 480 })
      .then(setQr)
      .catch(() => setQr(""));
  }, [open, card]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40 print:static print:bg-white" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="hc-title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-[2rem] bg-white p-8 text-aura-deep print:max-h-none"
      >
        <h2 id="hc-title" className="text-4xl font-extrabold hc:text-black">
          {t(locale, "healthCardTitle")}
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-3 text-3xl sm:grid-cols-2">
          <Field label="姓名" value={card.name} />
          <Field label="年龄" value={String(card.age)} />
          <Field label="血型" value={card.bloodType} />
          <Field label="紧急联络" value={`${card.emergencyContact.name} · ${card.emergencyContact.phone}`} />
          <Field label="过敏" value={card.allergies.join("、") || "—"} />
          <Field label="长期病" value={card.chronicConditions.join("、") || "—"} />
          <Field label="用药" value={card.medications.join("、") || "—"} wide />
        </div>
        {qr ? (
          <img src={qr} alt="健康卡二维码" className="mx-auto mt-8 h-56 w-56" />
        ) : null}
        <button
          onClick={onClose}
          className="mt-8 w-full rounded-3xl bg-aura-deep px-8 py-6 text-3xl font-bold text-white focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm"
        >
          {t(locale, "confirmNo")}
        </button>
      </section>
    </div>
  );
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <div className="text-2xl font-bold text-aura-warm">{label}</div>
      <div className="text-3xl font-semibold">{value}</div>
    </div>
  );
}