import { useCallback, useState } from "react";
import { useStore } from "jotai";
import {
  useQueryClient,
  type QueryObserverResult,
} from "@tanstack/react-query";
import type { ThreadTimelineResponse, TimelineRow } from "@bb/server-contract";
import {
  areTimelinePaginationCursorsEqual,
  buildLoadedTimelineState,
  buildLoadedTimelineFromPages,
  reconcileLoadedTimelineWithHistoryPages,
  tryMergeLoadedTimelineWithLatest,
  mergeLoadedTimelineWithLatest,
  prependOlderTimelineRows,
  resolveLoadedTimelineSurfaceKey,
  type LoadedTimelineState,
} from "@bb/client-core";
import { useConnectionAwareQueryState } from "@/hooks/queries/connection-aware-query-state";
import { threadTimelineQueryKey } from "@/hooks/queries/query-keys";
import { isTransientReadError } from "@/hooks/queries/query-helpers";
import { useThreadTimeline } from "@/hooks/queries/thread-queries";
import { BbHttpError } from "@/lib/sdk";
import { useThreadHistory } from "@/hooks/queries/thread-history-query";
import type { ThreadHistoryChain } from "@/hooks/cache-owners/thread-history-cache-owner";
import { threadTimelineScrollAnchorAtomFamily } from "@/lib/thread-timeline-scroll-anchor";

type TimelineQueryResultProp =
  keyof QueryObserverResult<ThreadTimelineResponse>;

const TIMELINE_CONTROLLER_PROPS_WITH_ROWS: TimelineQueryResultProp[] = [
  "data",
  "error",
  "isLoading",
  "isLoadingError",
];

export const TIMELINE_CONTROLLER_PROPS_WITHOUT_ROWS: TimelineQueryResultProp[] =
  [...TIMELINE_CONTROLLER_PROPS_WITH_ROWS, "isFetching"];

interface UseThreadTimelineControllerArgs {
  enabled?: boolean;
  surfaceKey?: string;
  threadId: string;
}

export interface UseThreadTimelineControllerResult {
  activePromptMode: ThreadTimelineResponse["activePromptMode"];
  activeThinking: ThreadTimelineResponse["activeThinking"];
  activeWorkflows: ThreadTimelineResponse["activeWorkflows"];
  activeBackgroundCommands: ThreadTimelineResponse["activeBackgroundCommands"];
  contextBoundarySeq: ThreadTimelineResponse["contextBoundarySeq"];
  contextWindowUsage: ThreadTimelineResponse["contextWindowUsage"];
  goal: ThreadTimelineResponse["goal"];
  modelFallback: ThreadTimelineResponse["modelFallback"];
  hasOlderTimelineRows: boolean;
  isLoadingOlderTimelineRows: boolean;
  loadOlderTimelineRows: () => Promise<void>;
  historyRefreshError: Error | null;
  historyUnrefreshed: boolean;
  historyReplacementKey: object | null;
  isRefreshingHistory: boolean;
  refreshHistory: () => Promise<void>;
  showLatestTimeline: () => void;
  pendingTodos: ThreadTimelineResponse["pendingTodos"];
  timelineError: Error | null;
  timelineLoading: boolean;
  timelineRows: TimelineRow[];
}

interface LoadedTimelineTracker {
  latestTimeline: ThreadTimelineResponse | undefined;
  history: ThreadHistoryChain | undefined;
  generation: number;
  loaded: LoadedTimelineState;
  unrefreshed: boolean;
  replacementKey: object | null;
}

function isAccessError(error: Error | null): boolean {
  return (
    error instanceof BbHttpError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function buildEmptyLoadedTimelineState(
  surfaceKey: string,
): LoadedTimelineState {
  return buildLoadedTimelineState({
    latestWindowEndSequence: null,
    latestRows: [],
    olderCursor: null,
    surfaceKey,
  });
}

export function useThreadTimelineController({
  enabled = true,
  surfaceKey: explicitSurfaceKey,
  threadId,
}: UseThreadTimelineControllerArgs): UseThreadTimelineControllerResult {
  const queryClient = useQueryClient();
  const notifyOnChangeProps = useCallback((): TimelineQueryResultProp[] => {
    const cachedTimeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey(threadId),
    );
    return cachedTimeline !== undefined && cachedTimeline.rows.length > 0
      ? TIMELINE_CONTROLLER_PROPS_WITH_ROWS
      : TIMELINE_CONTROLLER_PROPS_WITHOUT_ROWS;
  }, [queryClient, threadId]);
  const latestTimelineQuery = useThreadTimeline(threadId, {
    enabled,
    notifyOnChangeProps,
    refetchOnMount: true,
  });
  const latestTimeline = latestTimelineQuery.data;
  const surfaceKey = resolveLoadedTimelineSurfaceKey(
    explicitSurfaceKey ?? threadId,
    latestTimeline,
  );
  const history = useThreadHistory({ threadId, latestTimeline, enabled });
  const store = useStore();
  const accessDenied = isAccessError(latestTimelineQuery.error);
  const blocked = accessDenied || history.isBlocked;
  const makeInitialLoaded = () => {
    if (blocked)
      return {
        loaded: buildEmptyLoadedTimelineState(surfaceKey),
        unrefreshed: false,
      };
    const retained =
      history.data &&
      buildLoadedTimelineFromPages({
        pages: history.data.pages.map((page) => page.response),
        surfaceKey,
      });
    const loaded = retained ?? buildEmptyLoadedTimelineState(surfaceKey);
    if (!latestTimeline) return { loaded, unrefreshed: false };
    const merged = tryMergeLoadedTimelineWithLatest({
      current: loaded,
      latestTimeline,
      surfaceKey,
    });
    if (merged) return { loaded: merged, unrefreshed: false };
    if (
      loaded.rows.length > 0 &&
      store.get(threadTimelineScrollAnchorAtomFamily(threadId))?.atBottom ===
        false
    ) {
      return { loaded, unrefreshed: true };
    }
    return {
      loaded: mergeLoadedTimelineWithLatest({
        current: loaded,
        latestTimeline,
        surfaceKey,
      }),
      unrefreshed: false,
    };
  };
  const [tracker, setTracker] = useState<LoadedTimelineTracker>(() => ({
    latestTimeline,
    history: history.data,
    generation: history.generation,
    ...makeInitialLoaded(),
    replacementKey: null,
  }));
  let current = tracker;
  if (
    tracker.latestTimeline !== latestTimeline ||
    tracker.history !== history.data ||
    tracker.generation !== history.generation ||
    tracker.loaded.surfaceKey !== surfaceKey ||
    (blocked && tracker.loaded.rows.length > 0)
  ) {
    let loaded = tracker.loaded;
    let unrefreshed = tracker.unrefreshed;
    let replacementKey = tracker.replacementKey;
    const detached =
      store.get(threadTimelineScrollAnchorAtomFamily(threadId))?.atBottom ===
      false;
    if (blocked) {
      loaded = buildEmptyLoadedTimelineState(surfaceKey);
      unrefreshed = false;
    } else if (
      loaded.surfaceKey !== surfaceKey ||
      tracker.generation !== history.generation
    ) {
      const initial = makeInitialLoaded();
      loaded = initial.loaded;
      unrefreshed = initial.unrefreshed;
      replacementKey = history.data?.pages[0] ?? latestTimeline ?? null;
    } else {
      if (history.data && tracker.history !== history.data) {
        const head = history.data.pages[0];
        const replaced = head !== tracker.history?.pages[0];
        const refreshed = replaced
          ? reconcileLoadedTimelineWithHistoryPages({
              current: loaded,
              pages: history.data.pages.map((page) => page.response),
              surfaceKey,
            })
          : null;
        if (!replaced) {
          for (const page of history.data.pages.slice(1)) {
            if (
              areTimelinePaginationCursorsEqual({
                left: loaded.olderCursor,
                right: page.requestCursor,
              })
            ) {
              loaded = {
                ...loaded,
                olderCursor: page.response.timelinePage.olderCursor,
                rows: prependOlderTimelineRows({
                  loadedRows: loaded.rows,
                  olderRows: page.response.rows,
                }),
              };
            }
          }
        } else if (refreshed) {
          loaded = refreshed;
          unrefreshed = false;
          replacementKey = head ?? null;
        } else {
          const rebuilt = buildLoadedTimelineFromPages({
            pages: history.data.pages.map((page) => page.response),
            surfaceKey,
          });
          if (!detached && rebuilt) {
            loaded = rebuilt;
            unrefreshed = false;
            replacementKey = head ?? null;
          } else {
            unrefreshed = true;
          }
        }
      }
      if (
        latestTimeline &&
        (tracker.latestTimeline !== latestTimeline ||
          tracker.history !== history.data)
      ) {
        const merged = tryMergeLoadedTimelineWithLatest({
          current: loaded,
          latestTimeline,
          surfaceKey,
        });
        if (merged) {
          loaded = merged;
        } else if (!detached || loaded.rows.length === 0) {
          loaded = mergeLoadedTimelineWithLatest({
            current: loaded,
            latestTimeline,
            surfaceKey,
          });
          unrefreshed = false;
          replacementKey = latestTimeline;
        } else {
          unrefreshed = true;
        }
      }
    }
    current = {
      latestTimeline,
      history: history.data,
      generation: history.generation,
      loaded,
      unrefreshed,
      replacementKey,
    };
    setTracker(current);
  }
  const loadedTimeline = current.loaded;
  const nextOlderCursor = blocked ? null : loadedTimeline.olderCursor;
  const hasOlderTimelineRows = nextOlderCursor !== null;
  const loadOlder = history.loadOlder;
  const loadOlderTimelineRows = useCallback(async (): Promise<void> => {
    if (!enabled || !latestTimeline || !nextOlderCursor || !threadId || blocked)
      return;
    const response = await loadOlder(nextOlderCursor);
    if (!response) return;
    setTracker((previous) => {
      if (
        previous.loaded.surfaceKey !== surfaceKey ||
        previous.generation !== history.generation ||
        !areTimelinePaginationCursorsEqual({
          left: previous.loaded.olderCursor,
          right: nextOlderCursor,
        })
      ) {
        return previous;
      }
      return {
        ...previous,
        loaded: {
          ...previous.loaded,
          olderCursor: response.timelinePage.olderCursor,
          rows: prependOlderTimelineRows({
            loadedRows: previous.loaded.rows,
            olderRows: response.rows,
          }),
        },
      };
    });
  }, [
    enabled,
    latestTimeline,
    nextOlderCursor,
    threadId,
    blocked,
    loadOlder,
    surfaceKey,
    history.generation,
  ]);
  const showLatestTimeline = useCallback(() => {
    if (!latestTimeline || blocked) return;
    setTracker((previous) => ({
      ...previous,
      loaded: mergeLoadedTimelineWithLatest({
        current: buildEmptyLoadedTimelineState(surfaceKey),
        latestTimeline,
        surfaceKey,
      }),
      unrefreshed: false,
      replacementKey: null,
    }));
  }, [blocked, latestTimeline, surfaceKey]);
  const timelineRows = blocked ? [] : loadedTimeline.rows;
  const timelineQueryState = useConnectionAwareQueryState({
    hasResolvedData:
      latestTimelineQuery.data !== undefined || timelineRows.length > 0,
    isFetching: latestTimelineQuery.isFetching,
    isLoadingError: latestTimelineQuery.isLoadingError,
    isRecoverableLoadingError: isTransientReadError(latestTimelineQuery.error),
  });
  const timelineLoading =
    latestTimelineQuery.isLoading ||
    (timelineQueryState.status === "loading" && timelineRows.length === 0) ||
    (latestTimelineQuery.isFetching && timelineRows.length === 0);
  const timelineError =
    timelineLoading || timelineQueryState.status !== "unavailable"
      ? null
      : latestTimelineQuery.error;

  return {
    activePromptMode: latestTimeline?.activePromptMode ?? null,
    activeThinking: latestTimeline?.activeThinking ?? null,
    activeWorkflows: latestTimeline?.activeWorkflows ?? [],
    activeBackgroundCommands: latestTimeline?.activeBackgroundCommands ?? [],
    contextBoundarySeq: latestTimeline?.contextBoundarySeq ?? null,
    contextWindowUsage: latestTimeline?.contextWindowUsage,
    goal: latestTimeline?.goal ?? null,
    modelFallback: latestTimeline?.modelFallback ?? null,
    hasOlderTimelineRows,
    isLoadingOlderTimelineRows: history.isLoadingOlder,
    loadOlderTimelineRows,
    historyRefreshError: blocked ? null : history.error,
    historyUnrefreshed: current.unrefreshed,
    historyReplacementKey: current.replacementKey,
    isRefreshingHistory: history.isFetching && !history.isLoadingOlder,
    refreshHistory: history.refresh,
    showLatestTimeline,
    pendingTodos: latestTimeline?.pendingTodos ?? null,
    timelineError,
    timelineLoading,
    timelineRows,
  };
}
