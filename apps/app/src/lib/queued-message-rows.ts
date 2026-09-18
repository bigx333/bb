import type { ThreadQueuedMessage } from "@bb/domain";
import type { Submission } from "@/lib/message-delivery/store";

export interface LocalQueuedMessageRow extends Pick<
  ThreadQueuedMessage,
  "id" | "threadId" | "content" | "createdAt" | "updatedAt"
> {
  model: Submission["request"]["model"];
  reasoningLevel: Submission["request"]["reasoningLevel"];
  permissionMode: Submission["request"]["permissionMode"];
  serviceTier: Submission["request"]["serviceTier"];
  source: "local";
  clientSubmissionId: string;
  initiator: "user";
  senderThreadId: null;
  groupWithNext: false;
  editable: boolean;
  deliveryStatus: "waiting" | "confirming" | "rejected";
  error: string | null;
}

export type QueuedMessageRow =
  | (ThreadQueuedMessage & { source?: "server" })
  | LocalQueuedMessageRow;

export function isLocalQueuedMessage(
  message: QueuedMessageRow,
): message is LocalQueuedMessageRow {
  return message.source === "local";
}

export function getServerQueuedMessages(
  messages: readonly QueuedMessageRow[],
): ThreadQueuedMessage[] {
  return messages.filter(
    (message): message is ThreadQueuedMessage => !isLocalQueuedMessage(message),
  );
}

export function projectQueuedMessageRows({
  serverMessages,
  submissions,
  connected,
}: {
  serverMessages: readonly ThreadQueuedMessage[];
  submissions: readonly Submission[];
  connected: boolean;
}): QueuedMessageRow[] {
  const acceptedIds = new Set(
    serverMessages.flatMap((message) =>
      message.clientSubmissionId ? [message.clientSubmissionId] : [],
    ),
  );
  const localMessages = submissions
    .filter(
      (submission) =>
        !submission.reconciled &&
        !acceptedIds.has(submission.clientSubmissionId),
    )
    .map((submission): LocalQueuedMessageRow => ({
      source: "local",
      id: submission.id,
      threadId: submission.threadId,
      clientSubmissionId: submission.clientSubmissionId,
      content: submission.request.input,
      model: submission.request.model,
      reasoningLevel: submission.request.reasoningLevel,
      permissionMode: submission.request.permissionMode,
      serviceTier: submission.request.serviceTier,
      initiator: "user",
      senderThreadId: null,
      groupWithNext: false,
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
      editable:
        submission.status === "rejected" ||
        (submission.status === "pending" && !submission.attempted),
      deliveryStatus:
        submission.status === "rejected"
          ? "rejected"
          : connected || submission.status === "accepted"
            ? "confirming"
            : "waiting",
      error: submission.status === "rejected" ? submission.error : null,
    }));
  return [...serverMessages, ...localMessages];
}
