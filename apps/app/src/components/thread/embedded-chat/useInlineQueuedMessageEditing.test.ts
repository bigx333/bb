// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalQueuedMessageRow,
  QueuedMessageRow,
} from "@/lib/queued-message-rows";
import type { SubmissionEditClaim } from "@/lib/message-delivery/store";
import { useInlineQueuedMessageEditing } from "./useInlineQueuedMessageEditing";

const store = vi.hoisted(() => ({
  acquire: vi.fn(),
  renew: vi.fn().mockResolvedValue(true),
  release: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}));

vi.mock("@/lib/message-delivery/store", () => ({
  acquireSubmissionEdit: store.acquire,
  renewSubmissionEdit: store.renew,
  releaseSubmissionEdit: store.release,
}));
vi.mock("@/lib/mutation-errors", () => ({
  showMutationErrorToast: store.toast,
}));

const row: LocalQueuedMessageRow = {
  source: "local",
  id: "local-one",
  clientSubmissionId: "submission-one",
  threadId: "thread-one",
  content: [{ type: "text", text: "Original message", mentions: [] }],
  model: undefined,
  reasoningLevel: undefined,
  permissionMode: undefined,
  serviceTier: undefined,
  createdAt: 1,
  updatedAt: 2,
  editable: true,
  groupWithNext: false,
  initiator: "user",
  senderThreadId: null,
  deliveryStatus: "waiting",
  error: null,
};
const claim: SubmissionEditClaim = {
  threadId: row.threadId,
  id: row.id,
  token: "edit-token",
  expiresAt: 45000,
};

function renderEditor() {
  return renderHook(
    ({ messages }: { messages: readonly QueuedMessageRow[] }) =>
      useInlineQueuedMessageEditing({
        ownerThreadId: row.threadId,
        queuedMessages: messages,
      }),
    { initialProps: { messages: [row] } },
  );
}

async function beginEditor(result: ReturnType<typeof renderEditor>["result"]) {
  await act(async () => {
    result.current.beginEditQueuedMessage({
      queuedMessageId: row.id,
      queuedMessageIndex: 0,
    });
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("local queued-message editing claim", () => {
  it("acquires the delivery pause before opening and renews it while reconnect updates the row", async () => {
    vi.useFakeTimers();
    let resolveClaim: (value: SubmissionEditClaim) => void = () => undefined;
    store.acquire.mockImplementationOnce(
      () =>
        new Promise<SubmissionEditClaim>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const { result, rerender } = renderEditor();
    act(() =>
      result.current.beginEditQueuedMessage({
        queuedMessageId: row.id,
        queuedMessageIndex: 0,
      }),
    );
    expect(result.current.inlineEditingQueuedMessage).toBeNull();
    await act(async () => {
      resolveClaim(claim);
    });
    expect(store.acquire).toHaveBeenCalledWith({
      threadId: row.threadId,
      id: row.id,
      expectedUpdatedAt: row.updatedAt,
    });
    act(() =>
      result.current.queuedMessageDraftSession?.setDraft((draft) => ({
        ...draft,
        text: "Unsaved correction",
      })),
    );
    rerender({ messages: [{ ...row, deliveryStatus: "confirming" }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(store.renew).toHaveBeenCalledWith(claim);
    expect(result.current.inlineEditingQueuedMessage?.draft.text).toBe(
      "Unsaved correction",
    );
    act(() => result.current.dismissInlineQueuedMessageEditor());
    expect(store.release).toHaveBeenCalledWith(claim);
    expect(result.current.inlineEditingQueuedMessage).toBeNull();
  });

  it("preserves unsaved corrections when a suspended tab loses its claim and the original leaves the queue", async () => {
    vi.useFakeTimers();
    store.acquire.mockResolvedValueOnce(claim);
    store.renew.mockResolvedValueOnce(false);
    const { result, rerender, unmount } = renderEditor();
    await beginEditor(result);
    act(() =>
      result.current.queuedMessageDraftSession?.setDraft((draft) => ({
        ...draft,
        text: "Do not discard this",
      })),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    rerender({ messages: [] });
    expect(result.current.inlineEditingQueuedMessage?.draft.text).toBe(
      "Do not discard this",
    );
    expect(store.toast).toHaveBeenCalledOnce();
    unmount();
    expect(store.release).toHaveBeenCalledWith(claim);
  });

  it("does not open an editor when delivery has already claimed the message", async () => {
    store.acquire.mockRejectedValueOnce(new Error("Already being delivered"));
    const { result } = renderEditor();
    await beginEditor(result);
    expect(result.current.inlineEditingQueuedMessage).toBeNull();
    expect(store.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackMessage: "Failed to edit queued message",
      }),
    );
  });

  it("releases an acquired claim if the composer unmounts while acquisition is pending", async () => {
    let resolveClaim: (value: SubmissionEditClaim) => void = () => undefined;
    store.acquire.mockImplementationOnce(
      () =>
        new Promise<SubmissionEditClaim>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const { result, unmount } = renderEditor();
    act(() =>
      result.current.beginEditQueuedMessage({
        queuedMessageId: row.id,
        queuedMessageIndex: 0,
      }),
    );
    unmount();
    await act(async () => {
      resolveClaim(claim);
    });
    expect(store.release).toHaveBeenCalledWith(claim);
  });
});
