import { useMemo, useSyncExternalStore } from "react";
import { getSubmissions, subscribeSubmissions } from "./store";

export function useThreadMessageSubmissions(threadId: string) {
  const entries = useSyncExternalStore(subscribeSubmissions, getSubmissions);
  return useMemo(
    () => entries.filter((entry) => entry.threadId === threadId),
    [entries, threadId],
  );
}
