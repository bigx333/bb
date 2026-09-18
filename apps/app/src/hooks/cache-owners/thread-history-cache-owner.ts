import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { isOptimisticTimelineRowId } from "@bb/client-core";
import { BbHttpError } from "@/lib/sdk";
import type {
  ThreadTimelineResponse,
  TimelinePaginationCursor,
} from "@bb/server-contract";
import {
  threadHistoryQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  threadTimelineQueryKeyPrefix,
  threadDetailBootstrapQueryKey,
  THREAD_QUERY_KEY,
  THREAD_TIMELINE_QUERY_KEY,
} from "../queries/query-keys";

export const THREAD_HISTORY_MAX_PAGES = 5;
export const THREAD_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export const THREAD_HISTORY_MAX_INACTIVE_ENTRIES = 10;

export interface ThreadHistoryPage {
  response: ThreadTimelineResponse;
  requestCursor: TimelinePaginationCursor | null;
  validatedAt: number;
  byteSize: number;
}

export interface ThreadHistoryChain {
  pages: ThreadHistoryPage[];
  surfaceKey: string;
}

interface ThreadHistoryGeneration {
  request: number;
  eviction: number;
  blocked: boolean;
  error: Error | null;
}

const generations = new WeakMap<
  QueryClient,
  Map<string, ThreadHistoryGeneration>
>();

export function getThreadHistoryGeneration(
  queryClient: QueryClient,
  threadId: string,
): ThreadHistoryGeneration {
  let threads = generations.get(queryClient);
  if (!threads) {
    threads = new Map();
    generations.set(queryClient, threads);
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const id = event.query.queryKey[1];
      if (typeof id !== "string") return;
      const root = event.query.queryKey[0];
      if (
        event.action.type === "error" &&
        (root === THREAD_QUERY_KEY ||
          root === THREAD_TIMELINE_QUERY_KEY ||
          root === threadDetailBootstrapQueryKey("")[0]) &&
        event.action.error instanceof BbHttpError &&
        [401, 403, 404].includes(event.action.error.status)
      ) {
        removeThreadHistory({
          queryClient,
          threadId: id,
          error: event.action.error,
        });
        return;
      }
      if (
        event.action.type !== "success" ||
        event.action.manual ||
        root !== THREAD_TIMELINE_QUERY_KEY
      )
        return;
      const generation = generations.get(queryClient)?.get(id);
      if (generation) {
        generation.blocked = false;
        generation.error = null;
      }
    });
  }
  let generation = threads.get(threadId);
  if (!generation) {
    generation = { request: 0, eviction: 0, blocked: false, error: null };
    threads.set(threadId, generation);
  }
  return generation;
}

export function createThreadHistoryPage(
  response: ThreadTimelineResponse,
  requestCursor: TimelinePaginationCursor | null,
  validatedAt = Date.now(),
): ThreadHistoryPage {
  const rows = response.rows.filter(
    (row) => !isOptimisticTimelineRowId(row.id),
  );
  const serverResponse =
    rows.length === response.rows.length ? response : { ...response, rows };
  return {
    response: serverResponse,
    requestCursor,
    validatedAt,
    byteSize: new TextEncoder().encode(JSON.stringify(serverResponse))
      .byteLength,
  };
}

export function compactThreadHistory(
  chain: ThreadHistoryChain,
): ThreadHistoryChain | undefined {
  let bytes = 0;
  const pages: ThreadHistoryPage[] = [];
  for (const page of chain.pages.slice(0, THREAD_HISTORY_MAX_PAGES)) {
    if (bytes + page.byteSize > THREAD_HISTORY_MAX_BYTES) break;
    pages.push(page);
    bytes += page.byteSize;
  }
  if (pages.length === 0) return undefined;
  return pages.length === chain.pages.length ? chain : { ...chain, pages };
}

export function pruneThreadHistory(queryClient: QueryClient): void {
  const inactive = queryClient
    .getQueryCache()
    .findAll({ queryKey: threadHistoryQueryKeyPrefix(), type: "inactive" })
    .filter((query) => query.getObserversCount() === 0)
    .sort(
      (left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt,
    );
  for (const [index, query] of inactive.entries()) {
    const chain = queryClient.getQueryData<ThreadHistoryChain>(query.queryKey);
    const compacted = chain && compactThreadHistory(chain);
    if (index >= THREAD_HISTORY_MAX_INACTIVE_ENTRIES || !compacted) {
      queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
    } else if (compacted !== chain) {
      queryClient.setQueryData(query.queryKey, compacted, {
        updatedAt: query.state.dataUpdatedAt,
      });
    }
  }
}

interface ThreadHistoryOwnerArgs {
  queryClient: QueryClient;
  threadId?: string;
  error?: Error;
}

function advanceThreadHistoryGeneration(
  { queryClient, threadId, error }: ThreadHistoryOwnerArgs,
  evict: boolean,
): void {
  const threadIds =
    threadId === undefined
      ? [...(generations.get(queryClient)?.keys() ?? [])]
      : [threadId];
  for (const id of threadIds) {
    const generation = getThreadHistoryGeneration(queryClient, id);
    generation.request += 1;
    if (evict) {
      generation.eviction += 1;
      generation.blocked = true;
      generation.error = error ?? null;
    }
  }
}

export async function invalidateThreadHistory(
  args: ThreadHistoryOwnerArgs,
): Promise<void> {
  advanceThreadHistoryGeneration(args, false);
  const filters = { queryKey: threadHistoryQueryKeyPrefix(args.threadId) };
  await args.queryClient.cancelQueries(filters);
  await args.queryClient.invalidateQueries(filters, { cancelRefetch: false });
}

export function cancelThreadHistoryRead({
  queryClient,
  queryKey,
}: {
  queryClient: QueryClient;
  queryKey: QueryKey;
}): Promise<void> {
  return queryClient.cancelQueries({ queryKey, exact: true });
}

export function removeThreadHistory(args: ThreadHistoryOwnerArgs): void {
  advanceThreadHistoryGeneration(args, true);
  const filters = { queryKey: threadHistoryQueryKeyPrefix(args.threadId) };
  void args.queryClient.cancelQueries(filters);
  void args.queryClient.cancelQueries({
    queryKey:
      args.threadId === undefined
        ? allThreadTimelineQueryKeyPrefix()
        : threadTimelineQueryKeyPrefix(args.threadId),
  });
  args.queryClient.removeQueries(filters);
}
