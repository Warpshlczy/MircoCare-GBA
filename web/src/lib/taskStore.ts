// taskStore.ts — IndexedDB IO for tasks. Browser-only (needs indexedDB).
//
// Kept apart from tasks.ts so the rules stay testable under plain `node`.
// Every write goes through `put("tasks", …)`; there is no separate index, the
// task volume is tiny (tens per day) and we always read the whole store.

import { all, del, put } from "./db.ts";
import { latestOpenTask, markDone, newTask } from "./tasks.ts";
import type { DoneResult, NewTaskInput } from "./tasks.ts";
import type { Task } from "./types";

export function listTasks(): Promise<Task[]> {
  return all<Task>("tasks");
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  const task = newTask(input);
  await put("tasks", task);
  return task;
}

export function saveTask(task: Task): Promise<IDBValidKey> {
  return put("tasks", task);
}

export async function deleteTask(id: string): Promise<void> {
  await del("tasks", id);
}

/** Confirm one task by id. Returns null when it no longer exists. */
export async function completeTask(id: string, at: number): Promise<DoneResult | null> {
  const tasks = await listTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  const result = markDone(task, at);
  if (!result.alreadyDone) await put("tasks", result.task);
  return result;
}

/**
 * "我食咗药" with no id: confirm the most recent open task, optionally narrowed
 * by a predicate (e.g. `t => /药|藥/.test(t.text)` for medication only).
 */
export async function completeLatest(
  at: number,
  prefer?: (t: Task) => boolean
): Promise<DoneResult | null> {
  const target = latestOpenTask(await listTasks(), prefer);
  if (!target) return null;
  return completeTask(target.id, at);
}
