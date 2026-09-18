import { useCallback, useRef, useState } from "react";
import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  type PromptInput,
} from "@bb/domain";
import type { PromptDraftState } from "@bb/client-core";
import type {
  CreateQueuedMessageRequest,
  SendMessageRequest,
} from "@bb/server-contract";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";
import { enqueueSubmission } from "@/lib/message-delivery/store";
import { notifyComposerSubmitted } from "@/lib/composer-submissions";

type DurableRequest =
  | { kind: "send"; request: SendMessageRequest }
  | { kind: "queue"; request: CreateQueuedMessageRequest };

export function isDurableMessageInput(input: readonly PromptInput[]): boolean {
  return (
    !isStandaloneBuiltinClearCommand(input) &&
    !isStandaloneBuiltinCompactCommand(input) &&
    !input.some(
      (block) =>
        block.type === "text" &&
        block.mentions.some(
          (mention) =>
            mention.resource.kind === "command" &&
            mention.resource.source === "command",
        ),
    )
  );
}

export function useDurableMessageSubmission(threadId: string) {
  const { data: config } = useSystemConfig();
  const connection = useServerConnectionState();
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const enabled = config?.featureFlags.durableMessageDelivery === true;
  const connected = connection === "connected";

  const enqueue = useCallback(
    async (
      submission: DurableRequest,
      draft: { storageKey: string; value: PromptDraftState },
      awaitAcceptance = false,
    ) => {
      if (savingRef.current) {
        throw new Error("A message is still being saved.");
      }
      if (!enabled || !isDurableMessageInput(submission.request.input)) {
        throw new Error("This message does not support offline delivery.");
      }
      savingRef.current = true;
      setIsSaving(true);
      try {
        if (submission.kind === "send") {
          const mode = submission.request.mode;
          if (mode !== "queue-if-active" && mode !== "start") {
            throw new Error("Steering requires a server connection.");
          }
          const saved = await enqueueSubmission({
            kind: "send",
            request: { ...submission.request, mode },
            threadId,
            draft,
            awaitAcceptance,
          });
          notifyComposerSubmitted({ kind: "thread", threadId });
          return saved;
        }
        const saved = await enqueueSubmission({
          ...submission,
          threadId,
          draft,
          awaitAcceptance,
        });
        notifyComposerSubmitted({ kind: "thread", threadId });
        return saved;
      } finally {
        savingRef.current = false;
        setIsSaving(false);
      }
    },
    [enabled, threadId],
  );

  return { enabled, connected, isSaving, enqueue };
}
