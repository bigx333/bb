import { useSyncExternalStore } from "react";
import { z } from "zod";
import { nanoid } from "nanoid";
import { threadQueuedMessageSchema } from "@bb/domain";
import { createQueuedMessageRequestSchema } from "@bb/server-contract";
import {
  parsePromptDraftStorage,
  serializePromptDraftStorage,
  type PromptDraftState,
} from "@bb/client-core";
import { clearStoredPromptDraftIfCurrentMatches } from "@/hooks/usePromptDraftStorage";
import { buildOptimisticQueuedMessage } from "@/hooks/cache-owners/thread-runtime-cache-owner";
import type { QueryClient } from "@tanstack/react-query";

const prefix = "bb.pending-thread-message.v1.";
const entrySchema = z.object({
  operation: z.enum(["send", "queue"]),
  request: createQueuedMessageRequestSchema.extend({
    id: z.string(),
    clientSubmissionId: z.string(),
  }),
  row: threadQueuedMessageSchema,
  draftKey: z.string().nullable(),
  draft: z.string().nullable(),
  error: z.string().nullable(),
});
export type PendingThreadMessage = z.infer<typeof entrySchema>;
let entries: PendingThreadMessage[] = [];
let initialized = false;
const listeners = new Set<() => void>();

function refresh(): void {
  const next: PendingThreadMessage[] = [];
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    return;
  }
  for (const key of keys) {
    if (!key?.startsWith(prefix)) continue;
    try {
      const parsed = entrySchema.safeParse(
        JSON.parse(localStorage.getItem(key) ?? "null"),
      );
      if (parsed.success) next.push(parsed.data);
    } catch {}
  }
  entries = next.sort(
    (a, b) =>
      a.row.createdAt - b.row.createdAt || a.row.id.localeCompare(b.row.id),
  );
  for (const listener of listeners) listener();
}

function initialize(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  refresh();
  for (const entry of entries) {
    if (entry.draftKey)
      clearStoredPromptDraftIfCurrentMatches(
        entry.draftKey,
        parsePromptDraftStorage(entry.draft),
      );
  }
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(prefix)) refresh();
  });
}

function subscribe(listener: () => void): () => void {
  initialize();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPendingThreadMessages(): readonly PendingThreadMessage[] {
  initialize();
  return entries;
}

export function usePendingThreadMessages(): readonly PendingThreadMessage[] {
  return useSyncExternalStore(
    subscribe,
    getPendingThreadMessages,
    getPendingThreadMessages,
  );
}

export function savePendingThreadMessage(entry: PendingThreadMessage): void {
  localStorage.setItem(
    prefix + entry.row.id,
    JSON.stringify(entrySchema.parse(entry)),
  );
  refresh();
}

export function removePendingThreadMessage(id: string): void {
  localStorage.removeItem(prefix + id);
  refresh();
}

export function retainThreadMessage(args: {
  queryClient: QueryClient;
  operation: PendingThreadMessage["operation"];
  request: z.infer<typeof createQueuedMessageRequestSchema> & { id: string };
  draft: PromptDraftState;
  draftKey: string | null;
}): void {
  initialize();
  const request = { ...args.request, clientSubmissionId: nanoid() };
  const row = buildOptimisticQueuedMessage({
    queryClient: args.queryClient,
    request,
    createdAt: Date.now(),
  });
  row.id = `qmsg_${request.id}_${request.clientSubmissionId}`;
  savePendingThreadMessage({
    operation: args.operation,
    request,
    row,
    draftKey: args.draftKey,
    draft: serializePromptDraftStorage(args.draft),
    error: null,
  });
}
