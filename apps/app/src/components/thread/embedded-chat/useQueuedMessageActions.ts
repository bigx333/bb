import { useCallback, useMemo, useRef, useState } from "react";
import type { PromptInput } from "@bb/domain";
import type { SendQueuedMessageMode } from "@bb/server-contract";
import type {
  QueuedMessageGroupBoundaryRequest,
  QueuedMessageProcessingAction,
} from "@/components/promptbox/banner/QueuedMessagesList";
import {
  useDeleteThreadQueuedMessage,
  useReorderThreadQueuedMessage,
  useSendThreadQueuedMessage,
  useSetThreadQueuedMessageGroupBoundary,
  useUpdateThreadQueuedMessage,
} from "@/hooks/mutations/thread-runtime-mutations";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import type { QueuedMessageReorderRequest } from "@/lib/queued-message-reorder";
import { BbHttpError } from "@/lib/sdk";
import type { InlineQueuedMessageEditState } from "./useInlineQueuedMessageEditing";
import {
  isLocalQueuedMessage,
  type QueuedMessageRow,
} from "@/lib/queued-message-rows";
import { deleteSubmission, editSubmission } from "@/lib/message-delivery/store";

type QueuedMessageSendGuard = "current-head" | "exists";

interface SendQueuedMessageByIdArgs {
  guard: QueuedMessageSendGuard;
  messageId: string;
  mode: SendQueuedMessageMode;
}

interface UseQueuedMessageActionsArgs {
  threadId: string;
  queuedMessages: readonly QueuedMessageRow[];
  sendProcessingPersistence: "clear-on-settle" | "until-left-queue";
  onSendSuccess?: () => void;
  onSaveSuccess?: () => void;
  inlineEditingQueuedMessage: InlineQueuedMessageEditState | null;
  dismissInlineQueuedMessageEditor: () => void;
  activeComposerDraftInput: PromptInput[];
}

interface UseQueuedMessageActionsResult {
  processingQueuedMessage: {
    action: QueuedMessageProcessingAction;
    id: string;
  } | null;
  queuedMessageActionPending: boolean;
  isUpdateQueuedMessagePending: boolean;
  sendQueuedMessageById: (args: SendQueuedMessageByIdArgs) => Promise<void>;
  handleSaveInlineQueuedMessage: () => Promise<void>;
  handleDeleteQueuedMessage: (queuedMessageId: string) => void;
  handleReorderQueuedMessage: (request: QueuedMessageReorderRequest) => void;
  handleSetQueuedMessageGroupBoundary: (
    request: QueuedMessageGroupBoundaryRequest,
  ) => void;
}

export function useQueuedMessageActions({
  threadId,
  queuedMessages,
  sendProcessingPersistence,
  onSendSuccess,
  onSaveSuccess,
  inlineEditingQueuedMessage,
  dismissInlineQueuedMessageEditor,
  activeComposerDraftInput,
}: UseQueuedMessageActionsArgs): UseQueuedMessageActionsResult {
  const updateQueuedMessage = useUpdateThreadQueuedMessage();
  const sendQueuedMessage = useSendThreadQueuedMessage();
  const deleteQueuedMessage = useDeleteThreadQueuedMessage();
  const reorderQueuedMessage = useReorderThreadQueuedMessage();
  const setQueuedMessageGroupBoundary =
    useSetThreadQueuedMessageGroupBoundary();
  const [processingQueuedMessage, setProcessingQueuedMessage] = useState<{
    action: QueuedMessageProcessingAction;
    id: string;
  } | null>(null);
  const queuedMessagesRef = useRef<readonly QueuedMessageRow[]>([]);
  queuedMessagesRef.current = queuedMessages;
  const [localAction, setLocalAction] = useState<"edit" | "delete" | null>(
    null,
  );
  const localActionPendingRef = useRef(false);

  const displayedProcessingQueuedMessage = useMemo(
    () =>
      sendProcessingPersistence === "until-left-queue"
        ? processingQueuedMessage &&
          queuedMessages.some(
            (message) => message.id === processingQueuedMessage.id,
          )
          ? processingQueuedMessage
          : null
        : processingQueuedMessage,
    [processingQueuedMessage, queuedMessages, sendProcessingPersistence],
  );

  const sendQueuedMessageById = useCallback(
    async ({ guard, messageId, mode }: SendQueuedMessageByIdArgs) => {
      const message = queuedMessagesRef.current.find(
        (row) => row.id === messageId,
      );
      if (!message || isLocalQueuedMessage(message)) {
        return;
      }
      if (
        guard === "current-head" &&
        queuedMessagesRef.current[0]?.id !== messageId
      ) {
        return;
      }

      setProcessingQueuedMessage({ id: messageId, action: "send" });
      try {
        await sendQueuedMessage.mutateAsync({
          id: threadId,
          mode,
          queuedMessageId: messageId,
        });
        onSendSuccess?.();
        if (
          mode === "steer" ||
          sendProcessingPersistence === "clear-on-settle"
        ) {
          setProcessingQueuedMessage((current) =>
            current?.id === messageId ? null : current,
          );
        }
      } catch (error) {
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to send queued message",
          lifecycleOperation: "send_queued_message",
        });
        setProcessingQueuedMessage((current) =>
          current?.id === messageId ? null : current,
        );
      }
    },
    [onSendSuccess, sendProcessingPersistence, sendQueuedMessage, threadId],
  );

  const handleSaveInlineQueuedMessage = useCallback(async () => {
    if (
      !inlineEditingQueuedMessage ||
      activeComposerDraftInput.length === 0 ||
      updateQueuedMessage.isPending ||
      localActionPendingRef.current
    ) {
      return;
    }
    if (
      inlineEditingQueuedMessage.ownerThreadId !== threadId ||
      (!inlineEditingQueuedMessage.localEditClaim &&
        !queuedMessagesRef.current.some(
          (message) =>
            message.id === inlineEditingQueuedMessage.queuedMessageId,
        ))
    ) {
      dismissInlineQueuedMessageEditor();
      return;
    }
    const { expectedUpdatedAt, ownerThreadId, queuedMessageId } =
      inlineEditingQueuedMessage;
    const message = queuedMessagesRef.current.find(
      (row) => row.id === queuedMessageId,
    );
    const local =
      inlineEditingQueuedMessage.localEditClaim !== undefined ||
      (message !== undefined && isLocalQueuedMessage(message));
    if (local && !inlineEditingQueuedMessage.localEditClaim) return;
    if (!local && (!message || !message.editable)) return;
    if (local) {
      localActionPendingRef.current = true;
      setLocalAction("edit");
    }
    setProcessingQueuedMessage({ id: queuedMessageId, action: "edit" });
    try {
      if (local) {
        await editSubmission({
          threadId: ownerThreadId,
          id: queuedMessageId,
          expectedUpdatedAt,
          input: activeComposerDraftInput,
          editToken: inlineEditingQueuedMessage.localEditClaim?.token,
        });
      } else {
        await updateQueuedMessage.mutateAsync({
          expectedUpdatedAt,
          id: ownerThreadId,
          input: activeComposerDraftInput,
          queuedMessageId,
        });
      }
      onSaveSuccess?.();
      dismissInlineQueuedMessageEditor();
    } catch (error) {
      if (error instanceof BbHttpError && error.status === 404) {
        dismissInlineQueuedMessageEditor();
      }
      showMutationErrorToast({
        error,
        fallbackMessage: "Failed to update queued message",
        lifecycleOperation: "update_queued_message",
      });
    } finally {
      if (local) {
        localActionPendingRef.current = false;
        setLocalAction(null);
      }
      setProcessingQueuedMessage((current) =>
        current?.id === queuedMessageId ? null : current,
      );
    }
  }, [
    activeComposerDraftInput,
    dismissInlineQueuedMessageEditor,
    inlineEditingQueuedMessage,
    onSaveSuccess,
    threadId,
    updateQueuedMessage,
  ]);

  const handleDeleteQueuedMessage = useCallback(
    (queuedMessageId: string) => {
      const message = queuedMessagesRef.current.find(
        (row) => row.id === queuedMessageId,
      );
      if (!message || localActionPendingRef.current) return;
      const local = isLocalQueuedMessage(message);
      if (local && !message.editable) return;
      if (local) {
        localActionPendingRef.current = true;
        setLocalAction("delete");
      }
      setProcessingQueuedMessage({ id: queuedMessageId, action: "delete" });
      const deletion = local
        ? deleteSubmission({
            threadId,
            id: queuedMessageId,
            expectedUpdatedAt: message.updatedAt,
          })
        : deleteQueuedMessage.mutateAsync({ id: threadId, queuedMessageId });
      void deletion
        .catch((error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to delete queued message",
            lifecycleOperation: "queue_message",
          });
        })
        .finally(() => {
          if (local) {
            localActionPendingRef.current = false;
            setLocalAction(null);
          }
          setProcessingQueuedMessage((current) =>
            current?.id === queuedMessageId ? null : current,
          );
        });
    },
    [deleteQueuedMessage, threadId],
  );

  const handleReorderQueuedMessage = useCallback(
    (request: QueuedMessageReorderRequest) => {
      if (queuedMessagesRef.current.some(isLocalQueuedMessage)) return;
      const ids = [
        request.queuedMessageId,
        request.previousQueuedMessageId,
        request.nextQueuedMessageId,
        request.groupBoundaryQueuedMessageId,
      ].filter((id) => id != null);
      if (
        ids.some(
          (id) =>
            !queuedMessagesRef.current.some((message) => message.id === id),
        )
      )
        return;
      void reorderQueuedMessage
        .mutateAsync({
          ...request,
          id: threadId,
        })
        .catch((error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to reorder queued message",
            lifecycleOperation: "reorder_queued_message",
          });
        });
    },
    [reorderQueuedMessage, threadId],
  );

  const handleSetQueuedMessageGroupBoundary = useCallback(
    (request: QueuedMessageGroupBoundaryRequest) => {
      if (queuedMessagesRef.current.some(isLocalQueuedMessage)) return;
      const ids = [
        request.groupBoundaryQueuedMessageId,
        ...request.expectedGroupedPrefixQueuedMessageIds,
      ];
      if (
        ids.some(
          (id) =>
            !queuedMessagesRef.current.some((message) => message.id === id),
        )
      )
        return;
      void setQueuedMessageGroupBoundary
        .mutateAsync({
          id: threadId,
          ...request,
        })
        .catch((error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to group queued messages",
            lifecycleOperation: "set_queued_message_group_boundary",
          });
        });
    },
    [setQueuedMessageGroupBoundary, threadId],
  );

  const queuedMessageActionPending =
    localAction !== null ||
    deleteQueuedMessage.isPending ||
    reorderQueuedMessage.isPending ||
    setQueuedMessageGroupBoundary.isPending ||
    sendQueuedMessage.isPending ||
    updateQueuedMessage.isPending;

  return {
    processingQueuedMessage: displayedProcessingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending:
      updateQueuedMessage.isPending || localAction === "edit",
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
    handleSetQueuedMessageGroupBoundary,
  };
}
