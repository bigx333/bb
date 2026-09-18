import { useMemo } from "react";
import type { ThreadQueuedMessage } from "@bb/domain";
import { useThreadMessageSubmissions } from "@/lib/message-delivery/useThreadMessageSubmissions";
import { projectQueuedMessageRows } from "@/lib/queued-message-rows";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";

export function useQueuedMessageRows(
  threadId: string,
  serverMessages: readonly ThreadQueuedMessage[],
) {
  const submissions = useThreadMessageSubmissions(threadId);
  const connected = useServerConnectionState() === "connected";
  return useMemo(
    () => projectQueuedMessageRows({ serverMessages, submissions, connected }),
    [serverMessages, submissions, connected],
  );
}
