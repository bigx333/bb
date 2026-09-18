// @vitest-environment jsdom

import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SubmissionClaim } from "./store";

let store: typeof import("./store");
let drafts: typeof import("@/hooks/usePromptDraftStorage");
const acceptance = {
  kind: "send" as const,
  result: { ok: true as const, delivery: "sent" as const },
};

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  store = await import("./store");
  drafts = await import("@/hooks/usePromptDraftStorage");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function enqueue(text: string, awaitAcceptance = false) {
  const accessor = drafts.getPromptDraftAccessor({
    kind: "thread",
    threadId: "thread-one",
    projectId: "project-one",
  });
  const draft = { text, mentions: [], attachments: [] };
  accessor.setDraft(draft);
  return store.enqueueSubmission({
    threadId: "thread-one",
    kind: "send",
    request: { mode: "queue-if-active", input: [{ type: "text", text }] },
    draft: { storageKey: accessor.storageKey, value: draft },
    awaitAcceptance,
  });
}

async function claim(
  owner: string,
  now = Date.now(),
  leaseMs = 45_000,
): Promise<SubmissionClaim> {
  const result = await store.claimSubmission("thread-one", owner, now, leaseMs);
  if (!("claim" in result)) throw new Error("Expected a submission claim");
  return result.claim;
}

it("commits distinct identical submissions in order before clearing their drafts", async () => {
  const first = await enqueue("Same message");
  const second = await enqueue("Same message");
  await store.refreshSubmissions();
  expect(first.clientSubmissionId).not.toBe(second.clientSubmissionId);
  expect(second.sequence).toBe(first.sequence + 1);
  expect(
    store.getSubmissions().map((entry) => entry.handoff.completed),
  ).toEqual([true, true]);
  expect(localStorage.getItem(first.handoff.storageKey)).toBeNull();
});

it("rolls back failed enqueue transactions without clearing the marked draft or consuming sequence", async () => {
  const add = vi
    .spyOn(IDBObjectStore.prototype, "add")
    .mockImplementationOnce(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
  await expect(enqueue("Keep this draft")).rejects.toThrow("Quota exceeded");
  await store.refreshSubmissions();
  expect(store.getSubmissions()).toEqual([]);
  const accessor = drafts.getPromptDraftAccessor({
    kind: "thread",
    threadId: "thread-one",
    projectId: "project-one",
  });
  expect(accessor.getCurrent().text).toBe("Keep this draft");
  add.mockRestore();
  expect((await enqueue("Try again")).sequence).toBe(0);
});

it("recovers a committed handoff after draft clearing failed, without losing a newer identical draft", async () => {
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementationOnce(() => {
      throw new Error("Clear failed");
    });
  const entry = await enqueue("Repeated text");
  remove.mockRestore();
  await store.refreshSubmissions();
  expect(store.getSubmissions()[0]?.handoff.completed).toBe(false);
  const accessor = drafts.getPromptDraftAccessor({
    kind: "thread",
    threadId: "thread-one",
    projectId: "project-one",
  });
  accessor.setDraft({ text: "New draft", mentions: [], attachments: [] });
  accessor.setDraft({ text: "Repeated text", mentions: [], attachments: [] });
  await store.completeSubmissionHandoff(entry);
  expect(accessor.getCurrent().text).toBe("Repeated text");
  await store.refreshSubmissions();
  expect(store.getSubmissions()[0]?.handoff.completed).toBe(true);
});

it("keeps an accepted record until its draft handoff also completes", async () => {
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementationOnce(() => {
      throw new Error("Clear failed");
    });
  const entry = await enqueue("Accepted before cleanup");
  remove.mockRestore();
  await store.settleSubmission(await claim("owner"), {
    kind: "accepted",
    accepted: acceptance,
  });
  await store.settleSubmission(await claim("owner"), { kind: "reconciled" });
  await store.refreshSubmissions();
  expect(store.getSubmissions()[0]).toMatchObject({
    status: "accepted",
    reconciled: true,
    handoff: { completed: false },
  });
  await store.completeSubmissionHandoff(entry);
  await store.refreshSubmissions();
  expect(store.getSubmissions()).toEqual([]);
});

it("atomically chooses one tab and fences expired settlement while retrying the same head", async () => {
  const first = await enqueue("First");
  await enqueue("Second");
  const now = Date.now();
  const results = await Promise.all([
    store.claimSubmission("thread-one", "tab-one", now, 10),
    store.claimSubmission("thread-one", "tab-two", now, 10),
  ]);
  expect(results.filter((result) => "claim" in result)).toHaveLength(1);
  const winner = results.find((result) => "claim" in result);
  if (!winner || !("claim" in winner))
    throw new Error("Expected a winning claim");
  const replacement = await claim("replacement", now + 11, 100);
  expect(replacement.entry.clientSubmissionId).toBe(first.clientSubmissionId);
  expect(
    await store.settleSubmission(
      winner.claim,
      { kind: "accepted", accepted: acceptance },
      now + 12,
    ),
  ).toBe(false);
  expect(
    await store.settleSubmission(
      replacement,
      { kind: "accepted", accepted: acceptance },
      now + 12,
    ),
  ).toBe(true);
});

it("skips retained rejection and corrects it with a new ID at the delivery tail", async () => {
  const first = await enqueue("Rejected");
  const second = await enqueue("Later");
  await store.settleSubmission(await claim("owner"), {
    kind: "rejected",
    error: "Invalid model",
  });
  const later = await claim("owner");
  expect(later.entry.id).toBe(second.id);
  await store.settleSubmission(later, {
    kind: "retry",
    error: "Disconnected",
    nextAttemptAt: Date.now() + 10_000,
  });
  await store.refreshSubmissions();
  const rejected = store
    .getSubmissions()
    .find((entry) => entry.id === first.id);
  if (!rejected) throw new Error("Rejected message was lost");
  await store.editSubmission({
    threadId: first.threadId,
    id: first.id,
    expectedUpdatedAt: rejected.updatedAt,
    input: [{ type: "text", text: "Corrected", mentions: [] }],
  });
  await store.refreshSubmissions();
  const corrected = store
    .getSubmissions()
    .find((entry) => entry.id === first.id);
  expect(corrected?.clientSubmissionId).not.toBe(first.clientSubmissionId);
  expect(corrected?.sequence).toBeGreaterThan(second.sequence);
  expect(corrected?.createdAt).toBe(first.createdAt);
});

it("pauses delivery while an inline edit owns the claim and sends the edited payload", async () => {
  const entry = await enqueue("Edit this");
  const edit = await store.acquireSubmissionEdit({
    threadId: entry.threadId,
    id: entry.id,
    expectedUpdatedAt: entry.updatedAt,
  });
  expect(
    await store.claimSubmission(entry.threadId, "sender", Date.now(), 45_000),
  ).toEqual({ wakeAt: edit.expiresAt });
  await store.editSubmission({
    threadId: entry.threadId,
    id: entry.id,
    expectedUpdatedAt: entry.updatedAt,
    input: [{ type: "text", text: "Updated", mentions: [] }],
    editToken: edit.token,
  });
  const delivering = await claim("sender");
  expect(delivering.entry.request.input).toEqual([
    { type: "text", text: "Updated", mentions: [] },
  ]);
});

it("resolves a programmatic caller after durable acceptance even when another reader completes cleanup", async () => {
  const entry = await enqueue("Programmatic message", true);
  const accepted = entry.acceptance;
  expect(accepted).toBeDefined();
  await store.settleSubmission(await claim("other-tab"), {
    kind: "accepted",
    accepted: acceptance,
  });
  await store.refreshSubmissions();
  await expect(accepted).resolves.toBeUndefined();
  await store.settleSubmission(await claim("other-tab"), {
    kind: "reconciled",
  });
  await store.refreshSubmissions();
  expect(store.getSubmissions()).toEqual([]);
});

it("reopens committed storage with the same transport identity", async () => {
  const original = await enqueue("Keep across reload");
  vi.resetModules();
  const reloaded = await import("./store");
  await reloaded.refreshSubmissions();
  expect(reloaded.getSubmissions()[0]).toMatchObject({
    id: original.id,
    clientSubmissionId: original.clientSubmissionId,
    handoff: { completed: true },
  });
  const next = await reloaded.claimSubmission(
    original.threadId,
    "reloaded-tab",
    Date.now(),
    45_000,
  );
  expect(next).toMatchObject({
    claim: { entry: { clientSubmissionId: original.clientSubmissionId } },
  });
});

it("fences an editor after expiry lets a delivery owner claim the saved payload", async () => {
  const original = await enqueue("Original payload");
  const edit = await store.acquireSubmissionEdit({
    threadId: original.threadId,
    id: original.id,
    expectedUpdatedAt: original.updatedAt,
  });
  const delivery = await store.claimSubmission(
    original.threadId,
    "replacement",
    edit.expiresAt + 1,
    45_000,
  );
  expect(delivery).toMatchObject({
    claim: { entry: { id: original.id, request: original.request } },
  });
  await expect(
    store.editSubmission({
      threadId: original.threadId,
      id: original.id,
      expectedUpdatedAt: original.updatedAt,
      input: [{ type: "text", text: "Unsaved new wording", mentions: [] }],
      editToken: edit.token,
    }),
  ).rejects.toThrow("already being delivered");
});

it("leaves a rejected original untouched when its correction transaction fails", async () => {
  const original = await enqueue("Original rejected payload");
  await store.settleSubmission(await claim("owner"), {
    kind: "rejected",
    error: "Invalid model",
  });
  await store.refreshSubmissions();
  const rejected = store.getSubmissions()[0];
  if (!rejected) throw new Error("Expected retained rejected message");
  const put = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementationOnce(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
  await expect(
    store.editSubmission({
      threadId: original.threadId,
      id: original.id,
      expectedUpdatedAt: rejected.updatedAt,
      input: [{ type: "text", text: "Corrected wording", mentions: [] }],
    }),
  ).rejects.toThrow("Quota exceeded");
  put.mockRestore();
  await store.refreshSubmissions();
  expect(store.getSubmissions()[0]).toEqual(rejected);
});
