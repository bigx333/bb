// @vitest-environment jsdom

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessageDeliveryOptions } from "./coordinator";

let store: typeof import("./store");
let coordinator: typeof import("./coordinator");
let stop: (() => void) | undefined;
const accepted = {
  kind: "send" as const,
  result: { ok: true as const, delivery: "sent" as const },
};

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  store = await import("./store");
  coordinator = await import("./coordinator");
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(async () => {
  stop?.();
  stop = undefined;
  await store.refreshSubmissions();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function enqueue(text: string) {
  const { getPromptDraftAccessor } =
    await import("@/hooks/usePromptDraftStorage");
  const accessor = getPromptDraftAccessor({
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
  });
}

function options(
  overrides: Partial<MessageDeliveryOptions> = {},
): MessageDeliveryOptions {
  return {
    getAvailability: () => ({ enabled: true, connected: true }),
    subscribeAvailability: () => () => undefined,
    deliver: vi.fn().mockResolvedValue(accepted),
    reconcile: vi.fn().mockResolvedValue(undefined),
    classifyFailure: (error) => ({
      kind: "unknown",
      message: error instanceof Error ? error.message : "Disconnected",
    }),
    ...overrides,
  };
}

it("retries authoritative reads after acceptance without sending again", async () => {
  await enqueue("Accepted message");
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });
  const deliver = vi.fn().mockResolvedValue(accepted);
  const reconcile = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Read disconnected"))
    .mockResolvedValue(undefined);
  stop = coordinator.startMessageDelivery(options({ deliver, reconcile }));
  await vi.waitFor(() =>
    expect(store.getSubmissions()[0]).toMatchObject({
      status: "accepted",
      error: "Read disconnected",
    }),
  );
  expect(deliver).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_100);
  await vi.waitFor(() => expect(store.getSubmissions()).toEqual([]));
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledTimes(2);
});

it("aborts a hung request and retries its same ID before delivering later work", async () => {
  const first = await enqueue("First message");
  const second = await enqueue("Second message");
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });
  const deliver = vi
    .fn<MessageDeliveryOptions["deliver"]>()
    .mockImplementationOnce(() => new Promise(() => undefined))
    .mockResolvedValue(accepted);
  const classifyFailure = vi.fn<MessageDeliveryOptions["classifyFailure"]>(
    (error) => ({
      kind: "unknown",
      message: error instanceof Error ? error.message : "Disconnected",
    }),
  );
  stop = coordinator.startMessageDelivery(
    options({ deliver, classifyFailure }),
  );
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
  const signal = deliver.mock.calls[0]?.[1];
  await vi.advanceTimersByTimeAsync(30_000);
  expect(signal?.aborted).toBe(true);
  expect(signal?.reason).toMatchObject({
    name: "TimeoutError",
    message: "Message delivery timed out",
  });
  await vi.waitFor(() =>
    expect(classifyFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "TimeoutError",
        message: "Message delivery timed out",
      }),
      expect.objectContaining({ clientSubmissionId: first.clientSubmissionId }),
    ),
  );
  await vi.advanceTimersByTimeAsync(1_100);
  await vi.waitFor(() => expect(store.getSubmissions()).toEqual([]));
  expect(deliver.mock.calls.map(([entry]) => entry.clientSubmissionId)).toEqual(
    [
      first.clientSubmissionId,
      first.clientSubmissionId,
      second.clientSubmissionId,
    ],
  );
});

it("keeps uncertain prior attempts when a later error cannot establish rejection", async () => {
  const first = await enqueue("Uncertain message");
  await enqueue("Must wait");
  const initial = await store.claimSubmission(
    first.threadId,
    "old-tab",
    Date.now(),
    45_000,
  );
  if (!("claim" in initial)) throw new Error("Expected a claim");
  await store.settleSubmission(initial.claim, {
    kind: "retry",
    error: "Response lost",
    nextAttemptAt: 0,
  });
  const deliver = vi.fn().mockRejectedValue(new Error("Thread archived"));
  stop = coordinator.startMessageDelivery(
    options({
      deliver,
      classifyFailure: () => ({ kind: "rejected", message: "Thread archived" }),
    }),
  );
  await vi.waitFor(() =>
    expect(store.getSubmissions()[0]).toMatchObject({
      id: first.id,
      status: "uncertain",
      error: "Thread archived",
    }),
  );
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(store.getSubmissions()[1]?.attempted).toBe(false);
});

it("retains terminal rejection while allowing the next message to proceed", async () => {
  const first = await enqueue("Rejected message");
  const second = await enqueue("Allowed message");
  const deliver = vi
    .fn()
    .mockRejectedValueOnce(new Error("Invalid model"))
    .mockResolvedValue(accepted);
  stop = coordinator.startMessageDelivery(
    options({
      deliver,
      classifyFailure: () => ({ kind: "rejected", message: "Invalid model" }),
    }),
  );
  await vi.waitFor(() =>
    expect(store.getSubmissions()).toEqual([
      expect.objectContaining({ id: first.id, status: "rejected" }),
    ]),
  );
  expect(deliver.mock.calls.map(([entry]) => entry.id)).toEqual([
    first.id,
    second.id,
  ]);
});

it("pauses saved submissions until both receipt support and connection return", async () => {
  await enqueue("Saved while offline");
  let enabled = false;
  let connected = true;
  let changed: () => void = () => undefined;
  const deliver = vi.fn().mockResolvedValue(accepted);
  stop = coordinator.startMessageDelivery(
    options({
      deliver,
      getAvailability: () => ({ enabled, connected }),
      subscribeAvailability: (listener) => {
        changed = listener;
        return () => undefined;
      },
    }),
  );
  await store.refreshSubmissions();
  expect(deliver).not.toHaveBeenCalled();
  enabled = true;
  connected = false;
  changed();
  await store.refreshSubmissions();
  expect(deliver).not.toHaveBeenCalled();
  connected = true;
  changed();
  await vi.waitFor(() => expect(store.getSubmissions()).toEqual([]));
  expect(deliver).toHaveBeenCalledTimes(1);
});
