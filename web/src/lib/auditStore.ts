// auditStore.ts — IndexedDB + outbox IO for the agent audit trail.
//
// Split from audit.ts for the same reason recordStore.ts is split from cards.ts:
// the wording rules stay pure and testable in plain Node, the browser-bound IO
// lives here. `node src/selfcheck.ts` imports audit.ts and never this file.
//
// Failure policy: EVERY function here swallows its own errors. An audit write is
// observability, and observability must never be able to break the thing it
// observes — a full quota or a wedged IndexedDB connection would otherwise turn
// "set my alarm for 8am" into a crash. The turn already succeeded; a missing
// audit line is a gap in the report, not a failure for the senior.

import { all, put } from "./db.ts";
import { auditForDay, newAuditEntry } from "./audit.ts";
import { flushOutboxOnce } from "./outboxRunner.ts";
import { enqueue } from "./outboxStore.ts";
import { dayKey } from "./tasks.ts";
import type { AgentAuditEntry, AgentAuditOutcome, Locale } from "./types.ts";

/** The `agent_audit` store has existed since db v5 and had no writer until now. */

export interface AuditInput {
  tool: string;
  outcome: AgentAuditOutcome;
  locale: Locale;
  at: number;
  /** two calls of the same tool in one turn must not collapse into one row */
  seq?: number;
}

/**
 * Writes one row and queues it for the family screen. Returns the row it wrote,
 * or null when storage failed (the caller does not need to care).
 *
 * The queue id is the row id, so a retry of the same row dedupes while two
 * different rows of the same tool stay separate.
 */
export async function recordAudit(input: AuditInput): Promise<AgentAuditEntry | null> {
  let entry: AgentAuditEntry;
  try {
    entry = newAuditEntry(input);
    await put("agent_audit", entry);
  } catch {
    return null;
  }
  try {
    await enqueue("agentAudit", entry, Date.now(), entry.id);
    // Kick, don't await: the senior is waiting for a spoken answer, not for the
    // network. The queue survives a failure here.
    void flushOutboxOnce();
  } catch {
    /* the row is already durable locally; the family loses one line, not the action */
  }
  return entry;
}

/** Today's rows, newest first. Read-only; never triggers a network call. */
export async function listAudit(day = dayKey(Date.now()), limit = 20): Promise<AgentAuditEntry[]> {
  try {
    return auditForDay(await all<AgentAuditEntry>("agent_audit"), day, limit);
  } catch {
    return [];
  }
}
