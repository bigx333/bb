import { useMemo, useSyncExternalStore } from "react";
import type { ThreadQueuedMessage } from "@bb/domain";
import {
  getSubmissions,
  subscribeSubmissions,
} from "@/lib/message-delivery/store";
import { projectQueuedMessageRows } from "@/lib/queued-message-rows";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";

export function useQueuedMessageRows(
  threadId: string,
  serverMessages: readonly ThreadQueuedMessage[],
) {
  const entries = useSyncExternalStore(subscribeSubmissions, getSubmissions);
  const submissions = useMemo(
    () => entries.filter((entry) => entry.threadId === threadId),
    [entries, threadId],
  );
  const connected = useServerConnectionState() === "connected";
  return useMemo(
    () => projectQueuedMessageRows({ serverMessages, submissions, connected }),
    [serverMessages, submissions, connected],
  );
}
