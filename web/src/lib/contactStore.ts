// contactStore.ts — the ONE contact the agent is allowed to dial.
//
// Source of truth is the health card (C's `contract.py:120`: `emergencyContact
// {name, phone}`). It is fetched over the network, which is exactly when it is
// unavailable: an offline senior asking "打畀阿明" would get "I don't know him".
// So the last fetched contact is cached on the device.
//
// Privacy boundary: the number is stored locally and used ONLY to prefill the
// dialler. It is never uploaded, never put in a task, never logged — the whole
// point of a local cache is that the network is not needed to use it.
//
// Only ONE contact is known by design. A model that names anyone else must be
// refused rather than mapped onto the nearest string: dialling the wrong person
// is the one mistake this assistant cannot take back.

import { getHealthCard } from "./api.ts";
import { get, put } from "./db.ts";

const KEY = "contact.emergency";

export interface KnownContact {
  name: string;
  phone: string;
  /** "大女" — spoken only when two people share a name */
  relation?: string | null;
}

/**
 * "陳小明（儿子）" -> { name: "陳小明", relation: "儿子" }.
 *
 * The seeded demo card puts the relationship inside the name, and the matcher
 * below accepts a name that CONTAINS the spoken words — so without this, saying
 * "儿子" would dial the emergency contact. A display label is not a name.
 */
export function splitDisplayName(raw: string): { name: string; relation: string | null } {
  const text = (raw ?? "").trim();
  const m = /^(.*?)\s*[（(]\s*(.+?)\s*[)）]\s*$/.exec(text);
  if (m && m[1].trim()) return { name: m[1].trim(), relation: m[2].trim() };
  return { name: text, relation: null };
}

/** Digits only, keeping a leading +. Used for de-duplication, never for dialling. */
function phoneKey(phone: string): string {
  const trimmed = (phone ?? "").replace(/[\s\-()]/g, "");
  return trimmed.startsWith("+") ? `+${trimmed.slice(1).replace(/\D/g, "")}` : trimmed.replace(/\D/g, "");
}

function usable(c: { name?: string; phone?: string } | null | undefined): boolean {
  return !!c && typeof c.name === "string" && c.name.trim().length > 0
    && typeof c.phone === "string" && phoneKey(c.phone).length >= 5;
}

/**
 * The list the agent is allowed to dial: family-curated `contacts` first, then
 * the SOS contact if it is not already there.
 *
 * De-duplicated by number, because the same person can legitimately appear in
 * both fields — and two rows for one person make every name match ambiguous,
 * which would turn "打畀阿明" into a refusal.
 */
export function dialableContacts(
  emergency: { name: string; phone: string } | null | undefined,
  contacts: ReadonlyArray<{ name: string; phone: string; relation?: string | null; id?: string }> | null | undefined
): KnownContact[] {
  const out: KnownContact[] = [];
  const seen = new Set<string>();

  for (const c of contacts ?? []) {
    if (!usable(c)) continue;
    const key = phoneKey(c.phone);
    if (seen.has(key)) continue;
    seen.add(key);
    const split = splitDisplayName(c.name);
    out.push({ name: split.name, phone: c.phone.trim(), relation: c.relation ?? split.relation });
  }

  if (usable(emergency)) {
    const key = phoneKey(emergency!.phone);
    if (!seen.has(key)) {
      const split = splitDisplayName(emergency!.name);
      out.push({ name: split.name, phone: emergency!.phone.trim(), relation: split.relation });
    }
  }
  return out;
}

interface ContactDoc {
  id: string;
  contacts: KnownContact[];
  at: number;
}

/** The cached contact, without touching the network. */
export async function cachedContacts(): Promise<KnownContact[]> {
  const doc = await get<ContactDoc>("meta", KEY).catch(() => undefined);
  return dialableContacts(null, doc?.contacts ?? []);
}

/**
 * Freshest contact available: the health card when reachable, otherwise the
 * last known one. Never throws — a failed lookup means "we know nobody", which
 * the executor turns into a refusal, not into dialling a guess.
 */
export async function emergencyContacts(now = Date.now()): Promise<KnownContact[]> {
  try {
    const card = await getHealthCard();
    // Family-curated list first, and the SOS contact only as a fallback: he can
    // always reach the person the family designated, nothing else.
    const list = dialableContacts(card?.emergencyContact, card?.contacts ?? []);
    if (list.length > 0) {
      await put<ContactDoc>("meta", { id: KEY, contacts: list, at: now }).catch(() => {});
    }
    return list;
  } catch {
    /* offline / not authenticated / stub backend — fall through to the cache */
  }
  return cachedContacts();
}
