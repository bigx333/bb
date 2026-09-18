import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPTIMISTIC_TIMELINE_ROW_ID_PREFIX } from "@bb/client-core";
import { createDeferredPromise } from "@bb/test-helpers";
import { BbHttpError } from "@/lib/sdk";
import { makeThreadTimelineResponse } from "@/test/fixtures/thread-responses";
import { systemRow } from "@/test/fixtures/thread-timeline-rows";
import {
  threadHistoryQueryKey,
  threadHistoryQueryKeyPrefix,
  threadQueryKey,
  threadTimelineQueryKey,
} from "../queries/query-keys";
import { HEAVY_PAYLOAD_GC_TIME_MS } from "../queries/query-policies";
import {
  compactThreadHistory,
  createThreadHistoryPage,
  getThreadHistoryGeneration,
  pruneThreadHistory,
  removeThreadHistory,
  THREAD_HISTORY_MAX_BYTES,
  type ThreadHistoryChain,
} from "./thread-history-cache-owner";

afterEach(() => vi.useRealTimers());

function chain(pageCount = 1): ThreadHistoryChain {
  return {
    surfaceKey: "thread-1:collapse",
    pages: Array.from({ length: pageCount }, (_, index) =>
      createThreadHistoryPage(
        makeThreadTimelineResponse({
          rows: [
            systemRow({
              id: `row-${index}`,
              seq: index,
              title: "Row",
              detail: null,
            }),
          ],
        }),
        index === 0 ? null : { anchorId: `anchor-${index}`, anchorSeq: index },
        100,
      ),
    ),
  };
}

describe("thread history cache ownership", () => {
  it("retains a contiguous prefix without renewing page validation", () => {
    const current = chain(7);
    const compacted = compactThreadHistory(current);
    expect(compacted?.pages).toEqual(current.pages.slice(0, 5));
    expect(compacted?.pages[0]).toBe(current.pages[0]);
    expect(compacted?.pages.every((page) => page.validatedAt === 100)).toBe(
      true,
    );
    current.pages[2]!.byteSize = THREAD_HISTORY_MAX_BYTES;
    expect(compactThreadHistory(current)?.pages).toEqual(
      current.pages.slice(0, 2),
    );
    current.pages[0]!.byteSize = THREAD_HISTORY_MAX_BYTES + 1;
    expect(compactThreadHistory(current)).toBeUndefined();
  });

  it("excludes optimistic rows from reusable history", () => {
    const serverRow = systemRow({
      id: "server",
      seq: 1,
      title: "Server",
      detail: null,
    });
    const optimisticRow = systemRow({
      id: `${OPTIMISTIC_TIMELINE_ROW_ID_PREFIX}pending`,
      seq: 2,
      title: "Pending",
      detail: null,
    });
    const response = makeThreadTimelineResponse({
      rows: [serverRow, optimisticRow],
    });
    expect(createThreadHistoryPage(response, null).response.rows).toEqual([
      serverRow,
    ]);
    expect(response.rows).toEqual([serverRow, optimisticRow]);
  });

  it("prunes only inactive history identities and keeps their prior timestamps", () => {
    const queryClient = new QueryClient();
    const activeKey = threadHistoryQueryKey("active", "active", 20);
    queryClient.setQueryData(activeKey, chain(), { updatedAt: 1 });
    const observer = new QueryObserver(queryClient, {
      queryKey: activeKey,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    const unrelatedKey = threadTimelineQueryKey("unrelated");
    queryClient.setQueryData(unrelatedKey, makeThreadTimelineResponse());
    for (let index = 0; index < 12; index += 1) {
      queryClient.setQueryData(
        threadHistoryQueryKey(`inactive-${index}`, "surface", 20),
        chain(7),
        { updatedAt: 100 + index },
      );
    }

    pruneThreadHistory(queryClient);

    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: threadHistoryQueryKeyPrefix() }),
    ).toHaveLength(11);
    expect(queryClient.getQueryData(activeKey)).toBeDefined();
    expect(queryClient.getQueryData(unrelatedKey)).toBeDefined();
    expect(
      queryClient.getQueryData(
        threadHistoryQueryKey("inactive-0", "surface", 20),
      ),
    ).toBeUndefined();
    const retained = threadHistoryQueryKey("inactive-11", "surface", 20);
    expect(queryClient.getQueryState(retained)?.dataUpdatedAt).toBe(111);
    expect(
      queryClient.getQueryData<ThreadHistoryChain>(retained)?.pages,
    ).toHaveLength(5);
    unsubscribe();
    queryClient.clear();
  });

  it("keeps eviction blocked through manual writes until an authoritative fetch", async () => {
    const queryClient = new QueryClient();
    getThreadHistoryGeneration(queryClient, "thread-1");
    removeThreadHistory({ queryClient, threadId: "thread-1" });
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeThreadTimelineResponse(),
    );
    expect(getThreadHistoryGeneration(queryClient, "thread-1").blocked).toBe(
      true,
    );
    await queryClient.fetchQuery({
      queryKey: threadTimelineQueryKey("thread-1"),
      queryFn: async () => makeThreadTimelineResponse({ maxSeq: 2 }),
      staleTime: 0,
    });
    expect(getThreadHistoryGeneration(queryClient, "thread-1").blocked).toBe(
      false,
    );
    expect(getThreadHistoryGeneration(queryClient, "thread-1").eviction).toBe(
      1,
    );
    queryClient.clear();
  });

  it("uses the existing inactivity collection interval", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const key = threadHistoryQueryKey("thread-1", "surface", 20);
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      initialData: chain(),
      staleTime: Infinity,
      gcTime: HEAVY_PAYLOAD_GC_TIME_MS,
    });
    const unsubscribe = observer.subscribe(() => {});
    unsubscribe();
    await vi.advanceTimersByTimeAsync(HEAVY_PAYLOAD_GC_TIME_MS - 1);
    expect(queryClient.getQueryData(key)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(queryClient.getQueryData(key)).toBeUndefined();
    queryClient.clear();
  });

  it("cancels a latest read started before eviction so its late success cannot unblock", async () => {
    const queryClient = new QueryClient();
    const pending =
      createDeferredPromise<ReturnType<typeof makeThreadTimelineResponse>>();
    let signal: AbortSignal | undefined;
    const read = queryClient
      .fetchQuery({
        queryKey: threadTimelineQueryKey("thread-1"),
        queryFn: ({ signal: requestSignal }) => {
          signal = requestSignal;
          return pending.promise;
        },
      })
      .catch(() => undefined);
    removeThreadHistory({ queryClient, threadId: "thread-1" });
    expect(signal?.aborted).toBe(true);
    pending.resolve(makeThreadTimelineResponse());
    await read;
    expect(getThreadHistoryGeneration(queryClient, "thread-1").blocked).toBe(
      true,
    );
    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
    ).toBeUndefined();
    queryClient.clear();
  });

  it("purges cached history when route metadata is denied", async () => {
    const queryClient = new QueryClient();
    const key = threadHistoryQueryKey("thread-1", "surface", 20);
    queryClient.setQueryData(key, chain());
    getThreadHistoryGeneration(queryClient, "thread-1");
    const error = new BbHttpError({
      status: 403,
      body: null,
      code: null,
      message: "Access denied",
    });
    await expect(
      queryClient.fetchQuery({
        queryKey: threadQueryKey("thread-1"),
        queryFn: () => Promise.reject(error),
        retry: false,
      }),
    ).rejects.toBe(error);
    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(getThreadHistoryGeneration(queryClient, "thread-1").blocked).toBe(
      true,
    );
    queryClient.clear();
  });
});
