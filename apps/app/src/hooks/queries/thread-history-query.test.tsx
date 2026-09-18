// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { resolveLoadedTimelineSurfaceKey } from "@bb/client-core";
import { createDeferredPromise } from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BbHttpError, sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeThreadTimelineResponse } from "@/test/fixtures/thread-responses";
import { systemRow } from "@/test/fixtures/thread-timeline-rows";
import { createBrowserLifecycleFetchController } from "../cache-owners/browser-lifecycle-cache-owner";
import {
  createThreadHistoryPage,
  invalidateThreadHistory,
  removeThreadHistory,
  type ThreadHistoryChain,
} from "../cache-owners/thread-history-cache-owner";
import { threadHistoryQueryKey, threadTimelineQueryKey } from "./query-keys";
import { useThreadHistory } from "./thread-history-query";
import { useThreadTimeline } from "./thread-queries";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();
  return { ...actual, sdk: { threads: { timeline: vi.fn() } } };
});

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(sdk.threads.timeline).mockReset();
  vi.restoreAllMocks();
});

function page(
  sequence: number,
  options: {
    kind?: "latest" | "older";
    snapshot?: string;
    final?: boolean;
  } = {},
): ThreadTimelineResponse {
  const snapshot = options.snapshot ?? "old";
  return makeThreadTimelineResponse({
    rows: [
      systemRow({
        id: `row-${sequence}`,
        seq: sequence,
        title: `${sequence}`,
        detail: null,
      }),
    ],
    maxSeq: snapshot === "old" ? 100 : 200,
    timelinePage: {
      kind: options.kind ?? "latest",
      historySnapshot: snapshot,
      returnedSegmentCount: 1,
      hasOlderRows: !options.final,
      olderCursor: options.final
        ? null
        : {
            anchorId: `${snapshot}:${sequence}`,
            anchorSeq: sequence,
          },
    },
  });
}

function seedHistory(
  queryClient: QueryClient,
  pages: ThreadTimelineResponse[],
  updatedAt = Date.now(),
) {
  const latest = pages[0]!;
  const surfaceKey = resolveLoadedTimelineSurfaceKey("thread-1", latest);
  const key = threadHistoryQueryKey(
    "thread-1",
    surfaceKey,
    latest.timelinePage.segmentLimit,
  );
  const chain: ThreadHistoryChain = {
    surfaceKey,
    pages: pages.map((response, index) =>
      createThreadHistoryPage(
        response,
        index === 0 ? null : pages[index - 1]!.timelinePage.olderCursor,
        updatedAt,
      ),
    ),
  };
  queryClient.setQueryData(threadTimelineQueryKey("thread-1"), latest);
  queryClient.setQueryData(key, chain, { updatedAt });
  return { chain, key };
}

describe("useThreadHistory", () => {
  it("returns fresh cached history immediately without a network read", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(30);
    const { chain } = seedHistory(queryClient, [
      latest,
      page(20, { kind: "older" }),
    ]);
    const { result } = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );

    expect(result.current.data).toBe(chain);
    expect(sdk.threads.timeline).not.toHaveBeenCalled();
  });

  it("preserves the initial miss path without fetching latest twice", async () => {
    const latest = page(30);
    vi.mocked(sdk.threads.timeline).mockResolvedValue(latest);
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => {
        const timeline = useThreadTimeline("thread-1");
        return useThreadHistory({
          threadId: "thread-1",
          latestTimeline: timeline.data,
        });
      },
      { wrapper },
    );

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.refresh();
    });
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
  });

  it("keeps stale rows visible and rebuilds with fresh opaque cursors", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(30);
    const { chain } = seedHistory(
      queryClient,
      [latest, page(20, { kind: "older" })],
      Date.now() - 10_000,
    );
    const freshLatest = createDeferredPromise<ThreadTimelineResponse>();
    const freshOlder = page(25, { kind: "older", snapshot: "fresh" });
    vi.mocked(sdk.threads.timeline)
      .mockReturnValueOnce(freshLatest.promise)
      .mockResolvedValueOnce(freshOlder);
    const { result } = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );

    expect(result.current.data).toBe(chain);
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledTimes(1));
    await act(async () => {
      freshLatest.resolve(page(40, { snapshot: "fresh" }));
    });
    await waitFor(() =>
      expect(result.current.data?.pages[1]?.response).toEqual(freshOlder),
    );
    expect(sdk.threads.timeline).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        beforeAnchorId: "fresh:40",
        beforeAnchorSeq: "40",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("retains the successful chain and validation times on refresh failure", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(30);
    const { chain } = seedHistory(
      queryClient,
      [latest, page(20, { kind: "older" })],
      Date.now() - 10_000,
    );
    const failure = new Error("Failed to fetch");
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(page(40, { snapshot: "fresh" }))
      .mockRejectedValueOnce(failure);
    const { result } = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.data).toBe(chain);
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    act(() => {
      queryClient.getQueryCache().onFocus();
      queryClient.getQueryCache().onOnline();
    });
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(page(40, { snapshot: "fresh" }))
      .mockResolvedValueOnce(page(25, { kind: "older", snapshot: "fresh" }));
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.data?.pages[1]?.response.rows[0]?.id).toBe("row-25");
  });

  it("deduplicates two readers and does not cancel when one unmounts", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(30);
    seedHistory(queryClient, [latest]);
    const pending = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline).mockReturnValue(pending.promise);
    const first = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );
    const second = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );
    const cursor = latest.timelinePage.olderCursor!;
    let firstRead!: Promise<ThreadTimelineResponse | undefined>;
    let secondRead!: Promise<ThreadTimelineResponse | undefined>;
    act(() => {
      firstRead = first.result.current.loadOlder(cursor);
      secondRead = second.result.current.loadOlder(cursor);
    });
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(sdk.threads.timeline).mock.calls[0]![0].signal;
    first.unmount();
    expect(signal?.aborted).toBe(false);
    const older = page(20, { kind: "older" });
    await act(async () => {
      pending.resolve(older);
      expect(await firstRead).toBe(older);
      expect(await secondRead).toBe(older);
    });
    await waitFor(() =>
      expect(second.result.current.data?.pages).toHaveLength(2),
    );
  });

  it("suspends and resumes an active older read without dropping its caller", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(30);
    seedHistory(queryClient, [latest]);
    const pending = createDeferredPromise<ThreadTimelineResponse>();
    const older = page(20, { kind: "older" });
    vi.mocked(sdk.threads.timeline)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(older);
    const { result } = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );
    let read!: Promise<ThreadTimelineResponse | undefined>;
    act(() => {
      read = result.current.loadOlder(latest.timelinePage.olderCursor!);
    });
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(sdk.threads.timeline).mock.calls[0]![0].signal;
    const lifecycle = createBrowserLifecycleFetchController(queryClient);
    act(() => lifecycle.suspend());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      lifecycle.resume();
      expect(await read).toBe(older);
    });
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    pending.resolve(page(10, { kind: "older" }));
  });

  it("purges pending work and ignores late results and optimistic writes", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(30);
    const { key } = seedHistory(queryClient, [latest]);
    const pending = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );
    let read!: Promise<ThreadTimelineResponse | undefined>;
    act(() => {
      read = result.current.loadOlder(latest.timelinePage.olderCursor!);
    });
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledTimes(1));
    await act(async () => {
      removeThreadHistory({ queryClient, threadId: "thread-1" });
      expect(await read).toBeUndefined();
    });
    expect(result.current.isBlocked).toBe(true);
    expect(result.current.generation).toBe(1);
    await act(async () => {
      pending.resolve(page(20, { kind: "older" }));
    });
    act(() =>
      queryClient.setQueryData(threadTimelineQueryKey("thread-1"), page(40)),
    );
    expect(result.current.data).toBeUndefined();
    expect(result.current.isBlocked).toBe(true);
    expect(queryClient.getQueryData(key)).toBeUndefined();
  });

  it("bounds reusable pages while returning deep foreground content", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(50);
    const { key } = seedHistory(queryClient, [latest]);
    const { result } = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );
    let cursor = latest.timelinePage.olderCursor!;
    for (const sequence of [40, 30, 20, 10, 0]) {
      const older = page(sequence, { kind: "older", final: sequence === 0 });
      vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(older);
      await act(async () => {
        expect(await result.current.loadOlder(cursor)).toBe(older);
        expect(queryClient.getQueryState(key)?.fetchStatus).toBe("idle");
        expect(
          queryClient.getQueryData<ThreadHistoryChain>(key)?.pages,
        ).toHaveLength(Math.min(6 - sequence / 10, 5));
      });
      if (older.timelinePage.olderCursor)
        cursor = older.timelinePage.olderCursor;
    }
    expect(result.current.data?.pages).toHaveLength(5);
    expect(result.current.data?.pages.at(-1)?.response.rows[0]?.id).toBe(
      "row-10",
    );
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(5);
  });

  it.each([401, 403, 404])(
    "clears cached history on an older read returning %s",
    async (status) => {
      const { queryClient, wrapper } = createQueryClientTestHarness();
      const latest = page(30);
      seedHistory(queryClient, [latest]);
      const failure = new BbHttpError({
        body: null,
        code: null,
        message: "Unavailable",
        status,
      });
      vi.mocked(sdk.threads.timeline).mockRejectedValueOnce(failure);
      const { result } = renderHook(
        () =>
          useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
        { wrapper },
      );
      await act(async () => {
        expect(
          await result.current.loadOlder(latest.timelinePage.olderCursor!),
        ).toBeUndefined();
      });
      expect(result.current.isBlocked).toBe(true);
      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBe(failure);
    },
  );

  it("services a foreground cursor before restarting an interrupted background chain", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(30);
    const { chain } = seedHistory(
      queryClient,
      [latest, page(20, { kind: "older" })],
      Date.now() - 10_000,
    );
    const background = createDeferredPromise<ThreadTimelineResponse>();
    const nextLatest = createDeferredPromise<ThreadTimelineResponse>();
    const foreground = page(10, { kind: "older" });
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(page(40, { snapshot: "fresh" }))
      .mockReturnValueOnce(background.promise)
      .mockResolvedValueOnce(foreground)
      .mockReturnValueOnce(nextLatest.promise);
    const { result } = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledTimes(2));
    const backgroundSignal = vi.mocked(sdk.threads.timeline).mock.calls[1]![0]
      .signal;
    await act(async () => {
      expect(
        await result.current.loadOlder(
          chain.pages[1]!.response.timelinePage.olderCursor!,
        ),
      ).toBe(foreground);
    });
    expect(backgroundSignal?.aborted).toBe(true);
    expect(sdk.threads.timeline).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ beforeAnchorId: "old:20" }),
    );
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledTimes(4));
    background.resolve(page(25, { kind: "older", snapshot: "fresh" }));
    expect(result.current.data?.pages[2]?.response).toEqual(foreground);
  });

  it("recovers an invalid cursor once and exposes a second failure", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(30);
    const { chain } = seedHistory(queryClient, [
      latest,
      page(20, { kind: "older" }),
    ]);
    const invalid = new BbHttpError({
      body: null,
      code: "invalid_request",
      message: "Invalid cursor",
      status: 400,
    });
    vi.mocked(sdk.threads.timeline)
      .mockRejectedValueOnce(invalid)
      .mockResolvedValueOnce(page(40, { snapshot: "fresh" }))
      .mockRejectedValueOnce(invalid);
    const { result } = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );
    await act(async () => {
      await expect(
        result.current.loadOlder(
          chain.pages[1]!.response.timelinePage.olderCursor!,
        ),
      ).rejects.toBe(invalid);
    });
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
    expect(result.current.data).toBe(chain);
    await waitFor(() => expect(result.current.error).toBe(invalid));
  });

  it("invalidates an obsolete refresh without publishing its result", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const latest = page(30);
    seedHistory(
      queryClient,
      [latest, page(20, { kind: "older" })],
      Date.now() - 10_000,
    );
    const obsolete = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(page(40, { snapshot: "fresh" }))
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce(page(50, { snapshot: "newest" }))
      .mockResolvedValueOnce(page(35, { kind: "older", snapshot: "newest" }));
    const { result } = renderHook(
      () => useThreadHistory({ threadId: "thread-1", latestTimeline: latest }),
      { wrapper },
    );
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledTimes(2));
    await act(async () => {
      await invalidateThreadHistory({ queryClient, threadId: "thread-1" });
    });
    await act(async () => {
      obsolete.resolve(page(25, { kind: "older", snapshot: "fresh" }));
    });
    expect(result.current.data?.pages[0]?.response.rows[0]?.id).toBe("row-50");
    expect(result.current.data?.pages[1]?.response.rows[0]?.id).toBe("row-35");
  });
});
