// tools.ts — the agent tools, declared as DATA. PURE: zero imports, no DOM.
//
// Why data and not code: this file is the contract three parties share.
//   - C turns `openAiTools()` into the `tools` array of POST /agent/turn, so the
//     model can emit function calls (docs/dev.md §3.5).
//   - `toolrun.ts` (W1) validates args against `schema`, then dispatches by name.
//   - `selfcheck.ts` asserts the registry stays well-formed (unique names,
//     legal risk, object schema, `additionalProperties: false`).
//
// `risk: "forbidden"` is deliberately NOT a tool. Forbidden is an utterance-level
// refusal rule in `agent.ts` (转账/汇款/付款/密码 → refuse, zero calls), because a
// tool the model is never allowed to call should not be offered to the model.

export type ToolRisk = "safe" | "confirm";

export type ToolPermission =
  | "SCHEDULE_EXACT_ALARM"
  | "ACCESS_FINE_LOCATION"
  | "CALL_PHONE"
  | "ACCESSIBILITY";

export interface PropSchema {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: readonly string[];
}

/** The narrow slice of JSON Schema the backend actually validates. */
export interface ToolSchema {
  type: "object";
  properties: Record<string, PropSchema>;
  required: readonly string[];
  additionalProperties: false;
}

export interface ToolDecl {
  name: string;
  /** English, written for the model (not for the senior). */
  description: string;
  schema: ToolSchema;
  risk: ToolRisk;
  /** Android permissions needed at run time; empty = none. */
  permissions: readonly ToolPermission[];
}

/**
 * Order matters only for the model's prompt; execution order comes from the
 * `calls` array. Keep `sos` first so a truncated tool list still contains it.
 */
export const TOOLS: readonly ToolDecl[] = [
  {
    name: "sos",
    description:
      "Escalate an emergency immediately (fall with no response, chest pain, cannot breathe, bleeding). " +
      "Never ask a follow-up question first. Contact the caregiver and, if possible, place a call.",
    schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short reason, e.g. fell_down, chest_pain, cannot_breathe.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    risk: "safe",
    permissions: [],
  },
  {
    name: "create_task",
    description:
      "Record something the senior wants remembered or done ('记住听日十点覆诊', '提醒我买药'). " +
      "Copy the senior's own words; do not invent dates that were not said.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The task text in the senior's own words." },
        dueAt: {
          type: "number",
          description: "Epoch ms deadline, only when the senior stated a time.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    risk: "safe",
    permissions: [],
  },
  {
    name: "complete_task",
    description:
      "Mark a task done by id or by a spoken query ('我食咗药'). Returns the confirm delay in minutes.",
    schema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Exact task id when known." },
        query: { type: "string", description: "Spoken words to match when the id is unknown." },
      },
      required: [],
      additionalProperties: false,
    },
    risk: "safe",
    permissions: [],
  },
  {
    name: "defer_task",
    description:
      "Push a task back when the senior says '等陣先' / '遲啲先' / '五分钟后'. Records the deferral " +
      "(an executive-function signal for the family report) and moves the due time forward.",
    schema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Exact task id when known." },
        query: { type: "string", description: "Spoken words to match when the id is unknown." },
        minutes: { type: "number", description: "How long to push it back. Default 10." },
      },
      required: [],
      additionalProperties: false,
    },
    risk: "safe",
    permissions: [],
  },
  {
    name: "set_alarm",
    description:
      "Set a local alarm at a clock time ('听日八点叫我'). Pass the time of day the senior said, NOT a computed timestamp.",
    schema: {
      type: "object",
      properties: {
        time: {
          type: "string",
          description: "24-hour clock time, exactly HH:MM, local time (e.g. '08:00').",
        },
        dayOffset: {
          type: "number",
          description:
            "0 = today (or tomorrow if that time already passed), 1 = tomorrow. Omit for 'today'.",
        },
        label: { type: "string", description: "What the alarm is for, spoken aloud." },
      },
      required: ["time", "label"],
      additionalProperties: false,
    },
    risk: "safe",
    permissions: ["SCHEDULE_EXACT_ALARM"],
  },
  {
    name: "locate",
    description: "Read the current coarse location. Foreground only; returns null when denied.",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    risk: "safe",
    permissions: ["ACCESS_FINE_LOCATION"],
  },
  {
    name: "navigate_home",
    description:
      "Tell the senior how far they are from home. Distance only: there is no compass, and " +
      "'head north-west' is useless to someone standing on a corner. Text only, no map SDK.",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    risk: "safe",
    permissions: [],
  },
  {
    name: "plan_route",
    description:
      "Plan how the senior gets somewhere they want to go ('帶我去街市', '點去公園', '規劃路線返屋企'). " +
      "There is no map SDK, so the plan is a short ordered checklist spoken aloud, saved as a task " +
      "that can be ticked off, and — for home — the actual distance. " +
      "Pass the destination in the senior's own words; omit it when they just want to go home.",
    schema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "Where they want to go, in their own words. Omit for home.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    risk: "safe",
    permissions: [],
  },
  {
    name: "call_contact",
    description:
      "Open the dialler for a person the FAMILY added to the health card. MUST restate the name and " +
      "get a yes before dialling; if the senior declines, cancel. Never auto-redial. A name we do not " +
      "have, or one shared by two people, is refused rather than guessed.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact name exactly as the senior said it." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    risk: "confirm",
    // ACTION_DIAL fills the number in and leaves the call button to the senior.
    // That needs no CALL_PHONE permission — the empty list is the honest one.
    permissions: [],
  },
  {
    name: "send_message",
    description:
      "Send a pre-approved template message to a named contact via the system share sheet. " +
      "Free-form text is rejected; only whitelisted templates are allowed.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact name." },
        text: { type: "string", description: "One of the whitelisted template sentences." },
      },
      required: ["name", "text"],
      additionalProperties: false,
    },
    risk: "confirm",
    permissions: [],
  },
  {
    name: "open_app",
    description:
      "Open one whitelisted app (微信/电话/相机/设置) by launching it. Refuse any other app.",
    schema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description: "Whitelisted app key.",
          enum: ["wechat", "phone", "camera", "settings"],
        },
      },
      required: ["app"],
      additionalProperties: false,
    },
    risk: "confirm",
    // Launched by package name, not by clicking: no accessibility service, and
    // nothing can be confirmed inside the app by mistake.
    permissions: [],
  },
  {
    name: "ui_tap_text",
    description:
      "Tap ONE node whose text matches, on the currently visible screen. Gives up after 3 failures. " +
      "Never used for irreversible actions (send, delete, pay).",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Visible text or contentDescription to tap." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    risk: "confirm",
    permissions: ["ACCESSIBILITY"],
  },
] as const;

/** OpenAI / DeepSeek function-calling shape — what C's /agent/turn consumes. */
export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: ToolSchema };
}

export function openAiTools(tools: readonly ToolDecl[] = TOOLS): OpenAiTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
}

export function toolByName(name: string, tools: readonly ToolDecl[] = TOOLS): ToolDecl | undefined {
  return tools.find((t) => t.name === name);
}

/** Names that require a spoken yes/no before running (docs/dev.md §3.5). */
export function confirmToolNames(tools: readonly ToolDecl[] = TOOLS): string[] {
  return tools.filter((t) => t.risk === "confirm").map((t) => t.name);
}

/** Every distinct Android permission the tool set may request. */
export function requiredPermissions(tools: readonly ToolDecl[] = TOOLS): ToolPermission[] {
  const out = new Set<ToolPermission>();
  for (const t of tools) for (const p of t.permissions) out.add(p);
  return [...out];
}
