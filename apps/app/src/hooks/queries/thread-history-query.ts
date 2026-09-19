import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  CancelledError,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ThreadTimelineResponse,
  TimelinePaginationCursor,
} from "@bb/server-contract";
import {
  areTimelinePaginationCursorsEqual,
  resolveLoadedTimelineSurfaceKey,
} from "@bb/client-core/timeline";
import { BbHttpError, sdk } from "@/lib/sdk";
import {
  compactThreadHistory,
  cancelThreadHistoryRead,
  createThreadHistoryPage,
  getThreadHistoryGeneration,
  pruneThreadHistory,
  removeThreadHistory,
  THREAD_HISTORY_MAX_BYTES,
  THREAD_HISTORY_MAX_PAGES,
  type ThreadHistoryChain,
} from "../cache-owners/thread-history-cache-owner";
import { HEAVY_PAYLOAD_QUERY_POLICY } from "./query-policies";
import { threadHistoryQueryKey, threadTimelineQueryKey } from "./query-keys";
import { fetchThreadTimeline } from "./thread-queries";

const HISTORY_STALE_TIME_MS = 2_000;

interface ForegroundRead {
  cursor: TimelinePaginationCursor;
  generation: number;
  promise: Promise<ThreadTimelineResponse | undefined>;
  resolve: (response: ThreadTimelineResponse | undefined) => void;
  reject: (error: unknown) => void;
  response: ThreadTimelineResponse | undefined;
}

interface HistoryReadState {
  foreground: ForegroundRead | undefined;
  refreshAfterForeground: boolean;
  forceRefresh: boolean;
}

const reads = new WeakMap<QueryClient, Map<string, HistoryReadState>>();

function historyReadState(
  queryClient: QueryClient,
  identity: string,
): HistoryReadState {
  let entries = reads.get(queryClient);
  if (!entries) {
    entries = new Map();
    reads.set(queryClient, entries);
  }
  let state = entries.get(identity);
  if (!state) {
    state = {
      foreground: undefined,
      refreshAfterForeground: false,
      forceRefresh: false,
    };
    entries.set(identity, state);
  }
  return state;
}

function isStaleCursor(error: unknown): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 400 &&
    error.code === "invalid_request"
  );
}

function isAccessFailure(error: unknown): error is BbHttpError {
  return (
    error instanceof BbHttpError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

interface UseThreadHistoryArgs {
  threadId: string;
  latestTimeline: ThreadTimelineResponse | undefined;
  enabled?: boolean;
}

export function useThreadHistory({
  threadId,
  latestTimeline,
  enabled = true,
}: UseThreadHistoryArgs) {
  const queryClient = useQueryClient();
  const surfaceKey = resolveLoadedTimelineSurfaceKey(threadId, latestTimeline);
  const segmentLimit = latestTimeline?.timelinePage.segmentLimit ?? 20;
  const queryKey = useMemo(
    () => threadHistoryQueryKey(threadId, surfaceKey, segmentLimit),
    [threadId, surfaceKey, segmentLimit],
  );
  const identity = JSON.stringify(queryKey);
  const state = historyReadState(queryClient, identity);
  const subscribe = useCallback(
    (listener: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (JSON.stringify(event.query.queryKey) === identity) {
          const foreground = state.foreground;
          if (
            foreground &&
            (event.type === "removed" ||
              foreground.generation !==
                getThreadHistoryGeneration(queryClient, threadId).request)
          ) {
            state.foreground = undefined;
            foreground.resolve(undefined);
          } else if (
            foreground &&
            event.type === "updated" &&
            event.action.type === "success" &&
            !event.action.manual
          ) {
            state.foreground = undefined;
            foreground.resolve(foreground.response);
          } else if (
            foreground &&
            event.type === "updated" &&
            event.action.type === "error"
          ) {
            if (event.action.error instanceof CancelledError) {
              foreground.response = undefined;
            } else {
              state.foreground = undefined;
              foreground.reject(event.action.error);
            }
          }
        }
        listener();
      }),
    [queryClient, threadId, identity, state],
  );
  const getGeneration = useCallback(() => {
    const owner = getThreadHistoryGeneration(queryClient, threadId);
    const fetchStatus =
      queryClient.getQueryState(queryKey)?.fetchStatus ?? "idle";
    return `${owner.eviction}:${owner.blocked}:${fetchStatus}`;
  }, [queryClient, threadId, queryKey]);
  useSyncExternalStore(subscribe, getGeneration, getGeneration);
  const owner = getThreadHistoryGeneration(queryClient, threadId);
  const canRead =
    enabled &&
    Boolean(threadId) &&
    latestTimeline !== undefined &&
    !owner.blocked;

  const query = useQuery<ThreadHistoryChain>({
    queryKey,
    enabled: canRead,
    ...HEAVY_PAYLOAD_QUERY_POLICY,
    initialData: () =>
      latestTimeline && !owner.blocked
        ? compactThreadHistory({
            surfaceKey,
            pages: [
              createThreadHistoryPage(
                latestTimeline,
                null,
                queryClient.getQueryState(threadTimelineQueryKey(threadId))
                  ?.dataUpdatedAt ?? Date.now(),
              ),
            ],
          })
        : undefined,
    initialDataUpdatedAt: () =>
      queryClient.getQueryState(threadTimelineQueryKey(threadId))
        ?.dataUpdatedAt,
    staleTime: (cached) => {
      const pages = cached.state.data?.pages;
      if (!pages?.length) return HISTORY_STALE_TIME_MS;
      const validatedAt = Math.min(...pages.map((page) => page.validatedAt));
      return Math.max(
        0,
        validatedAt + HISTORY_STALE_TIME_MS - cached.state.dataUpdatedAt,
      );
    },
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryFn: async ({ signal }) => {
      const requestGeneration = owner.request;
      const current = queryClient.getQueryData<ThreadHistoryChain>(queryKey);
      const forceRefresh =
        state.forceRefresh ||
        queryClient.getQueryState(queryKey)?.isInvalidated === true;
      state.forceRefresh = false;
      const foreground =
        state.foreground?.generation === requestGeneration
          ? state.foreground
          : undefined;
      if (state.foreground && !foreground) {
        state.foreground.resolve(undefined);
        state.foreground = undefined;
      }
      const assertCurrent = () => {
        if (signal.aborted || owner.request !== requestGeneration) {
          throw new CancelledError({ revert: true });
        }
      };
      const fetchOlder = async (cursor: TimelinePaginationCursor) => {
        const response = await sdk.threads.timeline({
          threadId,
          beforeAnchorId: cursor.anchorId,
          beforeAnchorSeq: String(cursor.anchorSeq),
          signal,
        });
        assertCurrent();
        return response;
      };
      const rebuild = async (): Promise<ThreadHistoryChain> => {
        assertCurrent();
        const latest = await queryClient.fetchQuery({
          queryKey: threadTimelineQueryKey(threadId),
          queryFn: ({ signal: latestSignal }) =>
            fetchThreadTimeline({
              queryClient,
              signal: latestSignal,
              threadId,
            }),
          staleTime: 0,
          retry: false,
        });
        assertCurrent();
        if (
          resolveLoadedTimelineSurfaceKey(threadId, latest) !== surfaceKey ||
          latest.timelinePage.segmentLimit !== segmentLimit
        ) {
          throw new CancelledError({ revert: true });
        }
        const retained = current && compactThreadHistory(current);
        const targetPages = retained?.pages.length ?? 1;
        const targetSequence =
          retained?.pages.at(-1)?.response.rows[0]?.sourceSeqStart;
        const pages = [
          createThreadHistoryPage(
            latest,
            null,
            Math.max(Date.now(), (current?.pages[0]?.validatedAt ?? 0) + 1),
          ),
        ];
        let bytes = pages[0].byteSize;
        while (pages.length < Math.min(targetPages, THREAD_HISTORY_MAX_PAGES)) {
          assertCurrent();
          if (state.foreground && state.foreground !== foreground) {
            throw new CancelledError({ revert: true });
          }
          const previous = pages.at(-1)!;
          const cursor = previous.response.timelinePage.olderCursor;
          if (!cursor || bytes >= THREAD_HISTORY_MAX_BYTES) break;
          const firstSequence = previous.response.rows[0]?.sourceSeqStart;
          if (
            targetSequence !== undefined &&
            firstSequence !== undefined &&
            firstSequence < targetSequence
          )
            break;
          const response = await fetchOlder(cursor);
          const page = createThreadHistoryPage(response, cursor);
          if (bytes + page.byteSize > THREAD_HISTORY_MAX_BYTES) break;
          pages.push(page);
          bytes += page.byteSize;
        }
        return (
          compactThreadHistory({ surfaceKey, pages }) ?? {
            surfaceKey,
            pages: [],
          }
        );
      };
      try {
        if (foreground) {
          const response = await fetchOlder(foreground.cursor);
          foreground.response = response;
          const previous = current?.pages.at(-1);
          if (
            current &&
            previous &&
            areTimelinePaginationCursorsEqual({
              left: previous.response.timelinePage.olderCursor,
              right: foreground.cursor,
            })
          ) {
            return (
              compactThreadHistory({
                ...current,
                pages: [
                  ...current.pages,
                  createThreadHistoryPage(response, foreground.cursor),
                ],
              }) ?? { surfaceKey, pages: [] }
            );
          }
          return current ?? { surfaceKey, pages: [] };
        }
        if ((!current || current.pages.length <= 1) && !forceRefresh) {
          const latest =
            queryClient.getQueryData<ThreadTimelineResponse>(
              threadTimelineQueryKey(threadId),
            ) ?? latestTimeline;
          assertCurrent();
          return latest
            ? (compactThreadHistory({
                surfaceKey,
                pages: [createThreadHistoryPage(latest, null)],
              }) ?? { surfaceKey, pages: [] })
            : { surfaceKey, pages: [] };
        }
        return await rebuild();
      } catch (error) {
        try {
          if (!isStaleCursor(error)) throw error;
          const rebuilt = await rebuild();
          return foreground
            ? { ...rebuilt, recoveredFromCursor: foreground.cursor }
            : rebuilt;
        } catch (readError) {
          if (isAccessFailure(readError)) {
            removeThreadHistory({ queryClient, threadId, error: readError });
            throw readError;
          }
          if (
            signal.aborted ||
            owner.request !== requestGeneration ||
            readError instanceof CancelledError
          ) {
            throw new CancelledError({ revert: true });
          }
          throw readError;
        }
      } finally {
        pruneThreadHistory(queryClient);
      }
    },
  });

  const refetch = query.refetch;
  const loadOlder = useCallback(
    async function loadOlderPage(
      cursor: TimelinePaginationCursor,
    ): Promise<ThreadTimelineResponse | undefined> {
      if (!canRead) return undefined;
      const cached = queryClient.getQueryData<ThreadHistoryChain>(queryKey);
      const page = cached?.pages.find((entry) =>
        areTimelinePaginationCursorsEqual({
          left: entry.requestCursor,
          right: cursor,
        }),
      );
      if (page) return page.response;
      if (state.foreground) {
        const existing = state.foreground;
        if (
          areTimelinePaginationCursorsEqual({
            left: existing.cursor,
            right: cursor,
          })
        )
          return existing.promise;
        await existing.promise;
        return loadOlderPage(cursor);
      }
      let resolve!: ForegroundRead["resolve"];
      let reject!: ForegroundRead["reject"];
      const promise = new Promise<ThreadTimelineResponse | undefined>(
        (onResolve, onReject) => {
          resolve = onResolve;
          reject = onReject;
        },
      );
      const foreground: ForegroundRead = {
        cursor,
        generation: owner.request,
        promise,
        resolve,
        reject,
        response: undefined,
      };
      state.refreshAfterForeground ||=
        queryClient.getQueryState(queryKey)?.fetchStatus === "fetching";
      state.foreground = foreground;
      void (async () => {
        await cancelThreadHistoryRead({ queryClient, queryKey });
        if (owner.request !== foreground.generation) {
          if (state.foreground === foreground) state.foreground = undefined;
          foreground.resolve(undefined);
          return;
        }
        await refetch({ cancelRefetch: false });
      })();
      return promise;
    },
    [canRead, owner, queryClient, queryKey, refetch, state],
  );

  const refresh = useCallback(async () => {
    if (!canRead) return;
    if (state.foreground) {
      await state.foreground.promise.catch(() => undefined);
    }
    state.foreground = undefined;
    state.refreshAfterForeground = false;
    state.forceRefresh = true;
    await refetch({ cancelRefetch: false });
  }, [canRead, refetch, state]);

  useEffect(() => {
    if (
      !canRead ||
      query.isFetching ||
      state.foreground ||
      !state.refreshAfterForeground
    )
      return;
    state.refreshAfterForeground = false;
    state.forceRefresh = true;
    void refetch({ cancelRefetch: false });
  }, [canRead, query.isFetching, refetch, state]);

  useEffect(() => {
    pruneThreadHistory(queryClient);
    return () => {
      queueMicrotask(() => {
        const cached = queryClient
          .getQueryCache()
          .find({ queryKey, exact: true });
        if (cached && cached.getObserversCount() > 0) return;
        state.foreground?.resolve(undefined);
        state.foreground = undefined;
        reads.get(queryClient)?.delete(identity);
        pruneThreadHistory(queryClient);
      });
    };
  }, [queryClient, identity, queryKey, state]);

  return {
    data: canRead ? query.data : undefined,
    generation: owner.eviction,
    isBlocked: owner.blocked,
    isFetching: query.isFetching,
    isLoadingOlder: query.isFetching && state.foreground !== undefined,
    error: owner.error ?? query.error,
    loadOlder,
    refresh,
  };
}
