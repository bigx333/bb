import { nanoid } from "nanoid";
import { z } from "zod";
import { promptTextMentionSchema, threadQueuedMessageSchema } from "@bb/domain";
import {
  createQueuedMessageRequestSchema,
  sendMessageRequestSchema,
  sendMessageResponseSchema,
  uploadedPromptAttachmentSchema,
} from "@bb/server-contract";
import {
  completePromptDraftSubmission,
  preparePromptDraftSubmission,
  getPromptDraftSubmissionHandoff,
} from "@/hooks/usePromptDraftStorage";

const databaseName = "bb-message-delivery";
const invalidationKey = "bb.message-delivery.changed";
const acceptedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), result: sendMessageResponseSchema }),
  z.object({
    kind: z.literal("queue"),
    result: threadQueuedMessageSchema.extend({
      replayed: z.boolean().optional(),
    }),
  }),
]);
const draftSchema = z.object({
  text: z.string(),
  mentions: z.array(promptTextMentionSchema),
  attachments: z.array(uploadedPromptAttachmentSchema),
});
const submissionFields = {
  version: z.literal(1),
  id: z.string().min(1),
  clientSubmissionId: z.string().min(1).max(128),
  threadId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  status: z.enum(["pending", "uncertain", "rejected", "accepted"]),
  attempted: z.boolean(),
  attempts: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  retainAcceptanceUntil: z.number().nullable(),
  acceptanceObserved: z.boolean(),
  nextAttemptAt: z.number().nonnegative(),
  error: z.string().nullable(),
  accepted: acceptedSchema.nullable(),
  reconciled: z.boolean(),
  handoff: z.object({
    storageKey: z.string(),
    draft: draftSchema,
    handoffId: z.string(),
    completed: z.boolean(),
  }),
};
export const submissionSchema = z
  .discriminatedUnion("kind", [
    z.object({
      ...submissionFields,
      kind: z.literal("send"),
      request: sendMessageRequestSchema.extend({
        clientSubmissionId: z.string().min(1).max(128),
        mode: z.enum(["start", "queue-if-active"]),
      }),
    }),
    z.object({
      ...submissionFields,
      kind: z.literal("queue"),
      request: createQueuedMessageRequestSchema.extend({
        clientSubmissionId: z.string().min(1).max(128),
      }),
    }),
  ])
  .refine(
    (entry) =>
      entry.request.clientSubmissionId === entry.clientSubmissionId &&
      (entry.accepted === null || entry.accepted.kind === entry.kind),
  );
export type Submission = z.infer<typeof submissionSchema>;
export type SubmissionAcceptance = z.infer<typeof acceptedSchema>;
export type SubmissionRequest =
  | {
      kind: "send";
      request: z.input<typeof sendMessageRequestSchema> & {
        mode: "start" | "queue-if-active";
      };
    }
  | {
      kind: "queue";
      request: z.input<typeof createQueuedMessageRequestSchema>;
    };
export type EnqueueSubmission = SubmissionRequest & {
  threadId: string;
  draft: { storageKey: string; value: z.infer<typeof draftSchema> };
  awaitAcceptance?: boolean;
};
export type EnqueuedSubmission = Submission & { acceptance?: Promise<void> };
const claimSchema = z.object({
  purpose: z.enum(["delivery", "edit"]),
  owner: z.string(),
  token: z.string(),
  expiresAt: z.number(),
  submissionId: z.string(),
});
const metadataSchema = z.object({
  threadId: z.string(),
  nextSequence: z.number().int().nonnegative(),
  claim: claimSchema.nullable(),
});
export type SubmissionClaim = z.infer<typeof claimSchema> & {
  threadId: string;
  entry: Submission;
};
export type ClaimResult =
  | { claim: SubmissionClaim }
  | { wakeAt: number | null };

let database: Promise<IDBDatabase> | null = null;
let snapshot: readonly Submission[] = [];
let snapshotText = "[]";
let storageError: Error | null = null;
const listeners = new Set<() => void>();
const handoffs = new Map<
  string,
  { id: string; operation: Promise<EnqueuedSubmission> }
>();
const acceptanceWaiters = new Map<
  string,
  {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const acceptanceRetentionMs = 24 * 60 * 60 * 1_000;
let observing = false;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const entries = request.result.createObjectStore("submissions", {
        keyPath: "id",
      });
      entries.createIndex("threadSequence", ["threadId", "sequence"], {
        unique: true,
      });
      request.result.createObjectStore("threads", { keyPath: "threadId" });
    };
    request.onsuccess = () => {
      const connection = request.result;
      connection.onversionchange = () => {
        connection.close();
        database = null;
      };
      resolve(connection);
    };
    request.onerror = () => {
      database = null;
      reject(
        request.error ?? new Error("Message storage could not be opened."),
      );
    };
    request.onblocked = () => {
      database = null;
      reject(new Error("Message storage is blocked by another app tab."));
    };
  });
  return database;
}

function readRequest(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Message storage could not be read."));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  action: (entries: IDBObjectStore, threads: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const connection = await openDatabase();
  const transaction = connection.transaction(["submissions", "threads"], mode, {
    durability: "strict",
  });
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error("Message storage transaction was aborted."),
      );
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Message storage transaction failed."),
      );
  });
  try {
    const result = await action(
      transaction.objectStore("submissions"),
      transaction.objectStore("threads"),
    );
    await done;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      await done.catch(() => undefined);
    }
    await done.catch(() => undefined);
    throw error;
  }
}

async function readThread(
  entries: IDBObjectStore,
  threadId: string,
): Promise<Submission[]> {
  const raw = await readRequest(
    entries
      .index("threadSequence")
      .getAll(
        IDBKeyRange.bound([threadId, 0], [threadId, Number.MAX_SAFE_INTEGER]),
      ),
  );
  return z.array(submissionSchema).parse(raw);
}

async function readMetadata(threads: IDBObjectStore, threadId: string) {
  const raw = await readRequest(threads.get(threadId));
  return raw === undefined
    ? { threadId, nextSequence: 0, claim: null }
    : metadataSchema.parse(raw);
}

function notify(): void {
  for (const listener of listeners) listener();
}

function changed(): void {
  try {
    localStorage.setItem(invalidationKey, nanoid());
  } catch {
    storageError = new Error(
      "Other tabs may not see saved message updates until they reconnect.",
    );
  }
  notify();
  void refreshSubmissions();
}

export async function refreshSubmissions(): Promise<void> {
  try {
    const entries = await transact("readonly", async (store) =>
      z.array(submissionSchema).parse(await readRequest(store.getAll())),
    );
    entries.sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
    for (const entry of entries) {
      const waiter = acceptanceWaiters.get(entry.id);
      if (
        !waiter ||
        (entry.status !== "accepted" && entry.status !== "rejected")
      )
        continue;
      clearTimeout(waiter.timer);
      acceptanceWaiters.delete(entry.id);
      if (entry.status === "accepted") {
        waiter.resolve();
        void acknowledgeAcceptance(entry.id).catch(() => undefined);
      } else waiter.reject(new Error(entry.error ?? "Message was rejected."));
    }
    const text = JSON.stringify(entries);
    const hadError = storageError !== null;
    storageError = null;
    if (snapshotText !== text) {
      snapshot = entries;
      snapshotText = text;
      notify();
    } else if (hadError) notify();
  } catch (error) {
    storageError =
      error instanceof Error
        ? error
        : new Error("Saved messages could not be read.");
    notify();
  }
}

export function getSubmissions(): readonly Submission[] {
  return snapshot;
}
export function getSubmissionStorageError(): Error | null {
  return storageError;
}
export function subscribeSubmissions(listener: () => void): () => void {
  listeners.add(listener);
  if (!observing) {
    observing = true;
    window.addEventListener("storage", (event) => {
      if (event.key === invalidationKey) {
        notify();
        void refreshSubmissions();
      }
    });
  }
  void refreshSubmissions();
  return () => listeners.delete(listener);
}

export function enqueueSubmission(
  input: EnqueueSubmission,
): Promise<EnqueuedSubmission> {
  const existing = handoffs.get(input.draft.storageKey);
  if (
    existing &&
    getPromptDraftSubmissionHandoff(input.draft.storageKey) === existing.id
  )
    return existing.operation;
  const id = nanoid();
  preparePromptDraftSubmission(input.draft.storageKey, input.draft.value, id);
  const acceptance = input.awaitAcceptance
    ? new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          acceptanceWaiters.delete(id);
          reject(
            new Error(
              "Message acceptance could not be confirmed within 24 hours. The saved message has been retained.",
            ),
          );
        }, acceptanceRetentionMs);
        acceptanceWaiters.set(id, { resolve, reject, timer });
      })
    : undefined;
  void acceptance?.catch(() => undefined);
  const operation = transact("readwrite", async (entries, threads) => {
    const metadata = await readMetadata(threads, input.threadId);
    const entry = submissionSchema.parse({
      ...input,
      request: { ...input.request, clientSubmissionId: id },
      version: 1,
      id,
      clientSubmissionId: id,
      sequence: metadata.nextSequence,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "pending",
      attempted: false,
      attempts: 0,
      retryCount: 0,
      retainAcceptanceUntil: input.awaitAcceptance
        ? Date.now() + acceptanceRetentionMs
        : null,
      acceptanceObserved: !input.awaitAcceptance,
      nextAttemptAt: 0,
      error: null,
      accepted: null,
      reconciled: false,
      handoff: {
        storageKey: input.draft.storageKey,
        draft: input.draft.value,
        handoffId: id,
        completed: false,
      },
    });
    await readRequest(entries.add(entry));
    await readRequest(
      threads.put({ ...metadata, nextSequence: metadata.nextSequence + 1 }),
    );
    return entry;
  })
    .then(async (entry) => {
      changed();
      try {
        await completeSubmissionHandoff(entry);
      } catch {
        changed();
      }
      return { ...entry, acceptance };
    })
    .catch((error) => {
      const waiter = acceptanceWaiters.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(
          error instanceof Error
            ? error
            : new Error("Message could not be saved."),
        );
        acceptanceWaiters.delete(id);
      }
      throw error;
    });
  handoffs.set(input.draft.storageKey, { id, operation });
  void operation
    .finally(() => {
      if (
        handoffs.get(input.draft.storageKey)?.id === id &&
        getPromptDraftSubmissionHandoff(input.draft.storageKey) !== id
      )
        handoffs.delete(input.draft.storageKey);
    })
    .catch(() => {
      if (handoffs.get(input.draft.storageKey)?.id === id)
        handoffs.delete(input.draft.storageKey);
    });
  return operation;
}

export async function completeSubmissionHandoff(
  entry: Submission,
): Promise<void> {
  if (entry.handoff.completed) return;
  completePromptDraftSubmission(
    entry.handoff.storageKey,
    entry.handoff.draft,
    entry.handoff.handoffId,
  );
  await transact("readwrite", async (entries) => {
    const raw = await readRequest(entries.get(entry.id));
    if (raw === undefined) return;
    const current = submissionSchema.parse(raw);
    if (current.handoff.handoffId !== entry.handoff.handoffId) return;
    if (
      current.status === "accepted" &&
      current.reconciled &&
      (current.acceptanceObserved ||
        (current.retainAcceptanceUntil ?? Infinity) <= Date.now())
    )
      await readRequest(entries.delete(entry.id));
    else
      await readRequest(
        entries.put({
          ...current,
          handoff: { ...current.handoff, completed: true },
        }),
      );
  });
  if (
    handoffs.get(entry.handoff.storageKey)?.id === entry.handoff.handoffId &&
    getPromptDraftSubmissionHandoff(entry.handoff.storageKey) !==
      entry.handoff.handoffId
  )
    handoffs.delete(entry.handoff.storageKey);
  changed();
}

export async function claimSubmission(
  threadId: string,
  owner: string,
  now: number,
  leaseMs: number,
): Promise<ClaimResult> {
  const result = await transact(
    "readwrite",
    async (entries, threads): Promise<ClaimResult> => {
      const metadata = await readMetadata(threads, threadId);
      if (metadata.claim && metadata.claim.expiresAt > now)
        return { wakeAt: metadata.claim.expiresAt };
      const rows = await readThread(entries, threadId);
      const entry = rows.find(
        (row) =>
          row.status !== "rejected" &&
          !(row.status === "accepted" && row.reconciled),
      );
      if (!entry) return { wakeAt: null };
      if (entry.nextAttemptAt > now) return { wakeAt: entry.nextAttemptAt };
      const claim = {
        purpose: "delivery" as const,
        owner,
        token: nanoid(),
        submissionId: entry.id,
        expiresAt: now + leaseMs,
      };
      const attempted =
        entry.status === "accepted"
          ? entry
          : {
              ...entry,
              attempted: true,
              attempts: entry.attempts + 1,
              status: "uncertain" as const,
              updatedAt: Math.max(Date.now(), entry.updatedAt + 1),
            };
      await readRequest(entries.put(attempted));
      await readRequest(threads.put({ ...metadata, claim }));
      return { claim: { ...claim, threadId, entry: attempted } };
    },
  );
  if ("claim" in result) changed();
  return result;
}

export async function renewSubmissionClaim(
  claim: SubmissionClaim,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  return transact("readwrite", async (_entries, threads) => {
    const metadata = await readMetadata(threads, claim.threadId);
    if (
      metadata.claim?.token !== claim.token ||
      metadata.claim.expiresAt <= now
    )
      return false;
    await readRequest(
      threads.put({
        ...metadata,
        claim: { ...metadata.claim, expiresAt: now + leaseMs },
      }),
    );
    return true;
  });
}

export type SubmissionSettlement =
  | { kind: "accepted"; accepted: SubmissionAcceptance }
  | {
      kind: "retry";
      nextAttemptAt: number;
      error: string;
      unattempted?: boolean;
    }
  | { kind: "rejected"; error: string }
  | { kind: "reconciled" };

export async function settleSubmission(
  claim: SubmissionClaim,
  settlement: SubmissionSettlement,
  now = Date.now(),
): Promise<boolean> {
  const result = await transact("readwrite", async (entries, threads) => {
    const metadata = await readMetadata(threads, claim.threadId);
    if (
      metadata.claim?.token !== claim.token ||
      metadata.claim.expiresAt <= now
    )
      return false;
    const current = submissionSchema.parse(
      await readRequest(entries.get(claim.submissionId)),
    );
    let next: Submission;
    if (settlement.kind === "accepted")
      next = submissionSchema.parse({
        ...current,
        accepted: acceptedSchema.parse(settlement.accepted),
        status: "accepted",
        error: null,
        nextAttemptAt: 0,
        retryCount: 0,
      });
    else if (settlement.kind === "reconciled")
      next = { ...current, reconciled: true };
    else if (settlement.kind === "rejected")
      next = { ...current, status: "rejected", error: settlement.error };
    else
      next = {
        ...current,
        error: settlement.error,
        nextAttemptAt: settlement.nextAttemptAt,
        retryCount: current.retryCount + 1,
        ...(settlement.unattempted && current.accepted === null
          ? {
              attempts: current.attempts - 1,
              attempted: current.attempts > 1,
              status:
                current.attempts > 1
                  ? ("uncertain" as const)
                  : ("pending" as const),
            }
          : {}),
      };
    if (
      next.status === "accepted" &&
      next.reconciled &&
      next.handoff.completed &&
      (next.acceptanceObserved ||
        (next.retainAcceptanceUntil ?? Infinity) <= now)
    )
      await readRequest(entries.delete(next.id));
    else
      await readRequest(
        entries.put({
          ...next,
          updatedAt: Math.max(Date.now(), next.updatedAt + 1),
        }),
      );
    await readRequest(threads.put({ ...metadata, claim: null }));
    return true;
  });
  if (result) changed();
  return result;
}

export async function editSubmission(input: {
  threadId: string;
  id: string;
  expectedUpdatedAt: number;
  input: Submission["request"]["input"];
  editToken?: string;
}): Promise<void> {
  await transact("readwrite", async (entries, threads) => {
    const raw = await readRequest(entries.get(input.id));
    if (raw === undefined)
      throw new Error(
        "This message is no longer available. Your edits have been kept.",
      );
    const current = submissionSchema.parse(raw);
    const metadata = await readMetadata(threads, input.threadId);
    if (
      current.threadId !== input.threadId ||
      current.updatedAt !== input.expectedUpdatedAt ||
      (current.attempted && current.status !== "rejected") ||
      (input.editToken !== undefined &&
        (metadata.claim?.purpose !== "edit" ||
          metadata.claim.token !== input.editToken ||
          metadata.claim.expiresAt <= Date.now())) ||
      (metadata.claim?.submissionId === current.id &&
        metadata.claim.token !== input.editToken)
    )
      throw new Error(
        "This message is already being delivered. Its contents cannot be changed.",
      );
    const replacementId =
      current.status === "rejected" ? nanoid() : current.clientSubmissionId;
    const sequence =
      current.status === "rejected" ? metadata.nextSequence : current.sequence;
    const next = submissionSchema.parse({
      ...current,
      request: {
        ...current.request,
        input: input.input,
        clientSubmissionId: replacementId,
      },
      clientSubmissionId: replacementId,
      sequence,
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      status: "pending",
      attempted: false,
      attempts: 0,
      retryCount: 0,
      error: null,
      nextAttemptAt: 0,
      accepted: null,
      reconciled: false,
      acceptanceObserved: true,
      retainAcceptanceUntil: null,
    });
    await readRequest(entries.put(next));
    await readRequest(
      threads.put({
        ...metadata,
        nextSequence:
          current.status === "rejected"
            ? metadata.nextSequence + 1
            : metadata.nextSequence,
        claim:
          metadata.claim?.token === input.editToken ? null : metadata.claim,
      }),
    );
  });
  changed();
}

export async function deleteSubmission(input: {
  threadId: string;
  id: string;
  expectedUpdatedAt: number;
}): Promise<void> {
  await transact("readwrite", async (entries, threads) => {
    const current = submissionSchema.parse(
      await readRequest(entries.get(input.id)),
    );
    const metadata = await readMetadata(threads, input.threadId);
    if (
      current.threadId !== input.threadId ||
      current.updatedAt !== input.expectedUpdatedAt ||
      (current.attempted && current.status !== "rejected") ||
      metadata.claim?.submissionId === current.id
    )
      throw new Error(
        "This message is already being delivered. Wait for confirmation before deleting it.",
      );
    await readRequest(entries.delete(current.id));
  });
  changed();
}

async function acknowledgeAcceptance(id: string): Promise<void> {
  await transact("readwrite", async (entries) => {
    const raw = await readRequest(entries.get(id));
    if (raw === undefined) return;
    const entry = submissionSchema.parse(raw);
    if (entry.status !== "accepted") return;
    if (entry.reconciled && entry.handoff.completed)
      await readRequest(entries.delete(id));
    else await readRequest(entries.put({ ...entry, acceptanceObserved: true }));
  });
  changed();
}

export async function pruneObservedSubmissions(
  now = Date.now(),
): Promise<void> {
  await transact("readwrite", async (entries) => {
    const rows = z
      .array(submissionSchema)
      .parse(await readRequest(entries.getAll()));
    for (const entry of rows) {
      if (
        entry.status === "accepted" &&
        entry.reconciled &&
        entry.handoff.completed &&
        (entry.acceptanceObserved ||
          (entry.retainAcceptanceUntil !== null &&
            entry.retainAcceptanceUntil <= now))
      )
        await readRequest(entries.delete(entry.id));
    }
  });
  changed();
}

export interface SubmissionEditClaim {
  threadId: string;
  id: string;
  token: string;
  expiresAt: number;
}

export async function acquireSubmissionEdit(input: {
  threadId: string;
  id: string;
  expectedUpdatedAt: number;
}): Promise<SubmissionEditClaim> {
  const result = await transact("readwrite", async (entries, threads) => {
    const current = submissionSchema.parse(
      await readRequest(entries.get(input.id)),
    );
    const metadata = await readMetadata(threads, input.threadId);
    if (
      current.threadId !== input.threadId ||
      current.updatedAt !== input.expectedUpdatedAt ||
      (current.attempted && current.status !== "rejected") ||
      (metadata.claim && metadata.claim.expiresAt > Date.now())
    )
      throw new Error(
        "This message is being delivered. Wait for confirmation before editing it.",
      );
    const claim = {
      purpose: "edit" as const,
      owner: nanoid(),
      token: nanoid(),
      submissionId: current.id,
      expiresAt: Date.now() + 45_000,
    };
    await readRequest(threads.put({ ...metadata, claim }));
    return {
      threadId: input.threadId,
      id: current.id,
      token: claim.token,
      expiresAt: claim.expiresAt,
    };
  });
  changed();
  return result;
}

export async function renewSubmissionEdit(
  claim: SubmissionEditClaim,
): Promise<boolean> {
  return transact("readwrite", async (_entries, threads) => {
    const metadata = await readMetadata(threads, claim.threadId);
    if (
      metadata.claim?.purpose !== "edit" ||
      metadata.claim.token !== claim.token ||
      metadata.claim.expiresAt <= Date.now()
    )
      return false;
    await readRequest(
      threads.put({
        ...metadata,
        claim: { ...metadata.claim, expiresAt: Date.now() + 45_000 },
      }),
    );
    return true;
  });
}

export async function releaseSubmissionEdit(
  claim: SubmissionEditClaim,
): Promise<void> {
  await transact("readwrite", async (_entries, threads) => {
    const metadata = await readMetadata(threads, claim.threadId);
    if (
      metadata.claim?.purpose !== "edit" ||
      metadata.claim.token !== claim.token
    )
      return;
    await readRequest(threads.put({ ...metadata, claim: null }));
  });
  changed();
}
