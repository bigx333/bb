import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isLocalQueuedMessage,
  type QueuedMessageRow,
} from "@/lib/queued-message-rows";
import {
  acquireSubmissionEdit,
  releaseSubmissionEdit,
  renewSubmissionEdit,
  type SubmissionEditClaim,
} from "@/lib/message-delivery/store";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import type { QueuedMessageEditRequest } from "@/components/promptbox/banner/QueuedMessagesList";
import type { PromptDraftState } from "@bb/client-core";
import { queuedInputToDraft } from "@bb/client-core";
import type { InlineComposerDraftSession } from "./useActiveComposerDraft";

export interface InlineQueuedMessageEditState {
  draft: PromptDraftState;
  editSessionId: number;
  expectedUpdatedAt: number;
  localEditClaim?: SubmissionEditClaim;
  model: QueuedMessageRow["model"];
  ownerThreadId: string;
  permissionMode: QueuedMessageRow["permissionMode"];
  queuedMessageId: string;
  queuedMessageIndex: number;
  reasoningLevel: QueuedMessageRow["reasoningLevel"];
  serviceTier: QueuedMessageRow["serviceTier"];
}

interface UseInlineQueuedMessageEditingArgs {
  ownerThreadId: string;
  queuedMessages: readonly QueuedMessageRow[];
  onBeginEdit?: () => void;
}

interface UseInlineQueuedMessageEditingResult {
  inlineEditingQueuedMessage: InlineQueuedMessageEditState | null;
  inlineEditingQueuedMessageRef: React.RefObject<InlineQueuedMessageEditState | null>;
  commitInlineQueuedMessage: (
    next: InlineQueuedMessageEditState | null,
  ) => void;
  updateInlineQueuedMessage: (
    updater: (
      current: InlineQueuedMessageEditState | null,
    ) => InlineQueuedMessageEditState | null,
  ) => void;
  dismissInlineQueuedMessageEditor: () => void;
  beginEditQueuedMessage: (request: QueuedMessageEditRequest) => void;
  queuedMessageDraftSession: InlineComposerDraftSession | null;
}

export function useInlineQueuedMessageEditing({
  ownerThreadId,
  queuedMessages,
  onBeginEdit,
}: UseInlineQueuedMessageEditingArgs): UseInlineQueuedMessageEditingResult {
  const [inlineEditingQueuedMessageState, setInlineEditingQueuedMessage] =
    useState<InlineQueuedMessageEditState | null>(null);
  const inlineEditingQueuedMessageRef =
    useRef<InlineQueuedMessageEditState | null>(null);
  const inlineEditSessionIdRef = useRef(0);
  const editRequestRef = useRef(0);
  const currentOwnerRef = useRef(ownerThreadId);
  currentOwnerRef.current = ownerThreadId;

  const queuedMessagesByIdRef = useRef<ReadonlyMap<string, QueuedMessageRow>>(
    new Map(),
  );
  queuedMessagesByIdRef.current = useMemo(() => {
    const next = new Map<string, QueuedMessageRow>();
    for (const message of queuedMessages) {
      next.set(message.id, message);
    }
    return next;
  }, [queuedMessages]);

  const commitInlineQueuedMessage = useCallback(
    (next: InlineQueuedMessageEditState | null) => {
      const previousClaim =
        inlineEditingQueuedMessageRef.current?.localEditClaim;
      if (
        previousClaim &&
        previousClaim.token !== next?.localEditClaim?.token
      ) {
        void releaseSubmissionEdit(previousClaim).catch(() => undefined);
      }
      inlineEditingQueuedMessageRef.current = next;
      setInlineEditingQueuedMessage(next);
    },
    [],
  );
  const updateInlineQueuedMessage = useCallback(
    (
      updater: (
        current: InlineQueuedMessageEditState | null,
      ) => InlineQueuedMessageEditState | null,
    ) => {
      commitInlineQueuedMessage(updater(inlineEditingQueuedMessageRef.current));
    },
    [commitInlineQueuedMessage],
  );
  const dismissInlineQueuedMessageEditor = useCallback(() => {
    editRequestRef.current += 1;
    commitInlineQueuedMessage(null);
  }, [commitInlineQueuedMessage]);

  const inlineEditingQueuedMessage = useMemo(
    () =>
      inlineEditingQueuedMessageState !== null &&
      inlineEditingQueuedMessageState.ownerThreadId === ownerThreadId &&
      (inlineEditingQueuedMessageState.localEditClaim !== undefined ||
        queuedMessages.some(
          (message) =>
            message.id === inlineEditingQueuedMessageState.queuedMessageId,
        ))
        ? inlineEditingQueuedMessageState
        : null,
    [inlineEditingQueuedMessageState, ownerThreadId, queuedMessages],
  );
  useEffect(() => {
    if (
      inlineEditingQueuedMessageState !== null &&
      inlineEditingQueuedMessage === null
    ) {
      dismissInlineQueuedMessageEditor();
    }
  }, [
    dismissInlineQueuedMessageEditor,
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageState,
  ]);

  useEffect(
    () => () => {
      editRequestRef.current += 1;
      const claim = inlineEditingQueuedMessageRef.current?.localEditClaim;
      if (claim) void releaseSubmissionEdit(claim).catch(() => undefined);
    },
    [],
  );

  const localEditClaim = inlineEditingQueuedMessage?.localEditClaim;
  useEffect(() => {
    if (!localEditClaim) return;
    let stopped = false;
    let renewing = false;
    const reportFailure = (error: Error) => {
      if (stopped) return;
      stopped = true;
      showMutationErrorToast({
        error,
        fallbackMessage:
          "The queued message is no longer available to edit. Your changes are still here.",
        lifecycleOperation: "update_queued_message",
      });
    };
    const interval = window.setInterval(() => {
      if (stopped || renewing) return;
      renewing = true;
      void renewSubmissionEdit(localEditClaim)
        .then((renewed) => {
          if (!renewed)
            reportFailure(
              new Error(
                "The queued message is no longer available to edit. Your changes are still here.",
              ),
            );
        })
        .catch(() =>
          reportFailure(
            new Error(
              "Could not keep this message paused for editing. Your changes are still here.",
            ),
          ),
        )
        .finally(() => {
          renewing = false;
        });
    }, 10_000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [localEditClaim]);

  const beginEditQueuedMessage = useCallback(
    ({ queuedMessageId, queuedMessageIndex }: QueuedMessageEditRequest) => {
      const queuedMessage = queuedMessagesByIdRef.current.get(queuedMessageId);
      if (!queuedMessage || !queuedMessage.editable) return;
      const requestId = ++editRequestRef.current;
      const openEditor = (claim?: SubmissionEditClaim) => {
        commitInlineQueuedMessage({
          draft: queuedInputToDraft(queuedMessage.content),
          editSessionId: (inlineEditSessionIdRef.current += 1),
          expectedUpdatedAt: queuedMessage.updatedAt,
          localEditClaim: claim,
          model: queuedMessage.model,
          ownerThreadId,
          permissionMode: queuedMessage.permissionMode,
          queuedMessageId,
          queuedMessageIndex,
          reasoningLevel: queuedMessage.reasoningLevel,
          serviceTier: queuedMessage.serviceTier,
        });
        onBeginEdit?.();
      };
      if (!isLocalQueuedMessage(queuedMessage)) {
        openEditor();
        return;
      }
      void acquireSubmissionEdit({
        threadId: ownerThreadId,
        id: queuedMessageId,
        expectedUpdatedAt: queuedMessage.updatedAt,
      })
        .then(async (claim) => {
          if (
            editRequestRef.current !== requestId ||
            currentOwnerRef.current !== ownerThreadId
          ) {
            await releaseSubmissionEdit(claim);
            return;
          }
          openEditor(claim);
        })
        .catch((error) => {
          if (
            editRequestRef.current !== requestId ||
            currentOwnerRef.current !== ownerThreadId
          )
            return;
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to edit queued message",
            lifecycleOperation: "update_queued_message",
          });
        });
    },
    [commitInlineQueuedMessage, onBeginEdit, ownerThreadId],
  );

  const editSessionId = inlineEditingQueuedMessage?.editSessionId ?? null;
  const queuedMessageDraftSession =
    useMemo<InlineComposerDraftSession | null>(() => {
      if (editSessionId === null) {
        return null;
      }
      return {
        editSessionId,
        setDraft: (update) => {
          const current = inlineEditingQueuedMessageRef.current;
          if (current === null) return;
          commitInlineQueuedMessage({
            ...current,
            draft: update(current.draft),
          });
        },
      };
    }, [commitInlineQueuedMessage, editSessionId]);

  return {
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageRef,
    commitInlineQueuedMessage,
    updateInlineQueuedMessage,
    dismissInlineQueuedMessageEditor,
    beginEditQueuedMessage,
    queuedMessageDraftSession,
  };
}
