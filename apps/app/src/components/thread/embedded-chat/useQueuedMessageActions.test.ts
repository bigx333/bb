// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadQueuedMessage } from "@bb/test-helpers/domain-fixtures";
import type { LocalQueuedMessageRow } from "@/lib/queued-message-rows";
import { useQueuedMessageActions } from "./useQueuedMessageActions";

const actions = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue(undefined),
  edit: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  reorder: vi.fn().mockResolvedValue(undefined),
  group: vi.fn().mockResolvedValue(undefined),
  editLocal: vi.fn().mockResolvedValue(undefined),
  deleteLocal: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useSendThreadQueuedMessage: () => ({
    mutateAsync: actions.send,
    isPending: false,
  }),
  useUpdateThreadQueuedMessage: () => ({
    mutateAsync: actions.edit,
    isPending: false,
  }),
  useDeleteThreadQueuedMessage: () => ({
    mutateAsync: actions.delete,
    isPending: false,
  }),
  useReorderThreadQueuedMessage: () => ({
    mutateAsync: actions.reorder,
    isPending: false,
  }),
  useSetThreadQueuedMessageGroupBoundary: () => ({
    mutateAsync: actions.group,
    isPending: false,
  }),
}));
vi.mock("@/lib/message-delivery/store", () => ({
  editSubmission: actions.editLocal,
  deleteSubmission: actions.deleteLocal,
}));
vi.mock("@/lib/mutation-errors", () => ({
  showMutationErrorToast: actions.toast,
}));

function localRow(editable: boolean): LocalQueuedMessageRow {
  return {
    source: "local",
    id: "local-one",
    clientSubmissionId: "submission-one",
    threadId: "thread-one",
    content: [{ type: "text", text: "Saved message", mentions: [] }],
    model: undefined,
    reasoningLevel: undefined,
    permissionMode: undefined,
    serviceTier: undefined,
    createdAt: 1,
    updatedAt: 2,
    editable,
    groupWithNext: false,
    initiator: "user",
    senderThreadId: null,
    deliveryStatus: editable ? "waiting" : "confirming",
    error: null,
  };
}

function renderActions(row: LocalQueuedMessageRow) {
  return renderHook(() =>
    useQueuedMessageActions({
      threadId: row.threadId,
      queuedMessages: [makeThreadQueuedMessage({ id: "server-one" }), row],
      sendProcessingPersistence: "clear-on-settle",
      inlineEditingQueuedMessage: {
        draft: { text: "Saved message", mentions: [], attachments: [] },
        editSessionId: 1,
        expectedUpdatedAt: row.updatedAt,
        localEditClaim: row.editable
          ? {
              threadId: row.threadId,
              id: row.id,
              token: "edit-token",
              expiresAt: 45000,
            }
          : undefined,
        model: row.model,
        ownerThreadId: row.threadId,
        permissionMode: row.permissionMode,
        queuedMessageId: row.id,
        queuedMessageIndex: 1,
        reasoningLevel: row.reasoningLevel,
        serviceTier: row.serviceTier,
      },
      dismissInlineQueuedMessageEditor: vi.fn(),
      activeComposerDraftInput: [
        { type: "text", text: "Corrected message", mentions: [] },
      ],
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("local queued-message action boundaries", () => {
  it("never sends an unaccepted ID even with guard none, and blocks uncertain edits, deletes, and mixed reorders", async () => {
    const row = localRow(false);
    const { result } = renderActions(row);
    await act(async () => {
      await result.current.sendQueuedMessageById({
        guard: "none",
        messageId: row.id,
        mode: "auto",
      });
      await result.current.handleSaveInlineQueuedMessage();
      result.current.handleDeleteQueuedMessage(row.id);
      result.current.handleReorderQueuedMessage({
        queuedMessageId: "server-one",
        previousQueuedMessageId: row.id,
        nextQueuedMessageId: null,
      });
      result.current.handleSetQueuedMessageGroupBoundary({
        groupBoundaryQueuedMessageId: row.id,
        expectedGroupedPrefixQueuedMessageIds: ["server-one", row.id],
      });
    });
    for (const action of [
      actions.send,
      actions.edit,
      actions.delete,
      actions.reorder,
      actions.group,
      actions.editLocal,
      actions.deleteLocal,
    ])
      expect(action).not.toHaveBeenCalled();
  });

  it("routes local edits and deletes through transactional storage without server mutations", async () => {
    const row = localRow(true);
    const { result } = renderActions(row);
    await act(async () => {
      await result.current.handleSaveInlineQueuedMessage();
    });
    expect(actions.editLocal).toHaveBeenCalledWith({
      threadId: row.threadId,
      id: row.id,
      expectedUpdatedAt: row.updatedAt,
      input: [{ type: "text", text: "Corrected message", mentions: [] }],
      editToken: "edit-token",
    });
    act(() => result.current.handleDeleteQueuedMessage(row.id));
    await waitFor(() =>
      expect(result.current.queuedMessageActionPending).toBe(false),
    );
    expect(actions.deleteLocal).toHaveBeenCalledWith({
      threadId: row.threadId,
      id: row.id,
      expectedUpdatedAt: row.updatedAt,
    });
    expect(actions.edit).not.toHaveBeenCalled();
    expect(actions.delete).not.toHaveBeenCalled();
  });

  it("keeps the inline edit available and reports a transaction race rather than falling through to the server", async () => {
    actions.editLocal.mockRejectedValueOnce(
      new Error("Delivery has already started"),
    );
    const { result } = renderActions(localRow(true));
    await act(async () => {
      await result.current.handleSaveInlineQueuedMessage();
    });
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackMessage: "Failed to update queued message",
      }),
    );
    expect(actions.edit).not.toHaveBeenCalled();
    expect(result.current.isUpdateQueuedMessagePending).toBe(false);
  });
});
