// Web NFC "碰一碰打卡". Medications are tapped to confirm a dose was taken.
// When NFC is unavailable (iOS Safari has no Web NFC, and many desktops lack it),
// callers MUST fall back to the large on-screen button — that manual path is part
// of correctness, not an optional extra.

interface NDEFRecordLike {
  recordType: string;
  data?: DataView;
  encoding?: string;
}
interface NDEFReadingEventLike {
  message: { records: NDEFRecordLike[] };
}
interface NDEFReaderLike {
  scan(): Promise<void>;
  write(msg: { records: { recordType: string; data: BufferSource; lang?: string }[] }): Promise<void>;
  onreading: ((e: NDEFReadingEventLike) => void) | null;
}
type NDEFReaderCtor = new () => NDEFReaderLike;

function ndefCtor(): NDEFReaderCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { NDEFReader?: NDEFReaderCtor };
  return w.NDEFReader ?? null;
}

export const NFC_SUPPORTED: boolean = ndefCtor() !== null;
export const MANUAL_FALLBACK_REQUIRED = !NFC_SUPPORTED;

function decode(rec: NDEFRecordLike): string | null {
  if (!rec.data) return null;
  try {
    return new TextDecoder(rec.encoding ?? "utf-8").decode(rec.data);
  } catch {
    return null;
  }
}

/** Scans once for a text tag. Resolves null when NFC is unsupported or unreadable. */
export function scanTag(): Promise<string | null> {
  const Ctor = ndefCtor();
  if (!Ctor) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new Ctor();
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    reader.onreading = (e) => {
      const text = e.message.records.map(decode).find((x): x is string => x !== null) ?? null;
      finish(text);
    };
    reader
      .scan()
      .then(() => {
        // no auto-timeout: caller controls lifecycle via UI dismissal
      })
      .catch(() => finish(null));
  });
}

/** Writes a text tag (used to provision a medication box). No-op-safe if unsupported. */
export async function writeTag(text: string): Promise<void> {
  const Ctor = ndefCtor();
  if (!Ctor) throw new Error("NFC_UNSUPPORTED");
  const reader = new Ctor();
  await reader.write({
    records: [{ recordType: "text", data: new TextEncoder().encode(text), lang: "zh-HK" }],
  });
}