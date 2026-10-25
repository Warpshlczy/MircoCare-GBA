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
}

interface ContactDoc {
  id: string;
  contacts: KnownContact[];
  at: number;
}

/** The cached contact, without touching the network. */
export async function cachedContacts(): Promise<KnownContact[]> {
  const doc = await get<ContactDoc>("meta", KEY).catch(() => undefined);
  return doc?.contacts ?? [];
}

/**
 * Freshest contact available: the health card when reachable, otherwise the
 * last known one. Never throws — a failed lookup means "we know nobody", which
 * the executor turns into a refusal, not into dialling a guess.
 */
export async function emergencyContacts(now = Date.now()): Promise<KnownContact[]> {
  try {
    const card = await getHealthCard();
    const c = card?.emergencyContact;
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    const phone = typeof c?.phone === "string" ? c.phone.trim() : "";
    if (name && phone) {
      await put<ContactDoc>("meta", { id: KEY, contacts: [{ name, phone }], at: now }).catch(() => {});
      return [{ name, phone }];
    }
  } catch {
    /* offline / not authenticated / stub backend — fall through to the cache */
  }
  return cachedContacts();
}
