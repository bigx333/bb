import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { appToast } from "@/components/ui/app-toast";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { invalidateSystemConfig } from "@/hooks/cache-owners/system-cache-effects";
import {
  applyQueuedMessageCreateResult,
  applySendThreadMessageSuccess,
  refreshAcceptedSubmissionQueries,
} from "@/hooks/cache-owners/thread-runtime-cache-owner";
import { BbHttpError, sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { startMessageDelivery } from "./coordinator";

const submissionRejectionSchema = z.object({
  details: z.object({
    submission: z.object({
      clientSubmissionId: z.string(),
      acceptance: z.literal("rejected"),
    }),
  }),
});

export function MessageDeliverySync() {
  const queryClient = useQueryClient();
  const { data: config } = useSystemConfig();
  const enabled = config?.featureFlags.durableMessageDelivery === true;
  const errorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let deliverySupported = true;
    const requireConfirmation = (
      expected: string,
      received: string | undefined,
    ) => {
      if (expected === received) return;
      deliverySupported = false;
      invalidateSystemConfig({ queryClient });
      const error = new Error(
        "Message delivery paused: the server did not confirm the saved submission ID.",
      );
      appToast.error(error.message);
      throw error;
    };
    return startMessageDelivery({
      getAvailability: () => ({
        enabled: deliverySupported,
        connected: wsManager.getConnectionState() === "connected",
      }),
      subscribeAvailability: (listener) =>
        wsManager.onConnectionStateChange(listener),
      deliver: async (entry, signal) => {
        if (entry.kind === "send") {
          const result = await sdk.threads.send({
            ...entry.request,
            threadId: entry.threadId,
            signal,
          });
          requireConfirmation(
            entry.clientSubmissionId,
            result.clientSubmissionId,
          );
          return { kind: "send", result };
        }
        const result = await sdk.threads.queuedMessages.create({
          ...entry.request,
          threadId: entry.threadId,
          signal,
        });
        requireConfirmation(
          entry.clientSubmissionId,
          result.clientSubmissionId,
        );
        return { kind: "queue", result };
      },
      reconcile: async (entry, accepted, signal) => {
        if (entry.kind === "send" && accepted.kind === "send") {
          applySendThreadMessageSuccess({
            queryClient,
            realtimeConnected: false,
            request: { ...entry.request, id: entry.threadId },
            result: accepted.result,
            transaction: undefined,
          });
        } else if (accepted.kind === "queue") {
          applyQueuedMessageCreateResult({
            queryClient,
            threadId: entry.threadId,
            queuedMessage: accepted.result,
            transaction: undefined,
          });
        }
        await refreshAcceptedSubmissionQueries({
          queryClient,
          threadId: entry.threadId,
          load: () =>
            sdk.threads.queuedMessages.list({
              threadId: entry.threadId,
              signal,
            }),
        });
      },
      classifyFailure: (error, entry) => {
        const message =
          error instanceof Error ? error.message : "Message delivery failed.";
        if (!(error instanceof BbHttpError))
          return { kind: "unknown", message };
        if (
          error.status === 408 ||
          error.status === 429 ||
          error.status >= 500 ||
          error.code === "queued_message_claim_lost" ||
          error.code === "queued_message_auto_send_paused" ||
          error.code === "awaiting_user_interaction" ||
          (error.status === 409 && error.code !== "client_submission_conflict")
        )
          return { kind: "transient", message };
        const rejection = submissionRejectionSchema.safeParse(error.body);
        return {
          kind: "rejected",
          message,
          resolvesUncertainty:
            rejection.success &&
            rejection.data.details.submission.clientSubmissionId ===
              entry.clientSubmissionId,
        };
      },
      onError: (error) => {
        if (errorRef.current === error.message) return;
        errorRef.current = error.message;
        appToast.error(error.message);
      },
    });
  }, [enabled, queryClient]);

  return null;
}
