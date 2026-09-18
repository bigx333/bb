import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ThreadChangeKind } from "@bb/domain";
import { makeThreadTimelineResponse } from "@/test/fixtures/thread-responses";
import {
  createThreadHistoryPage,
  getThreadHistoryGeneration,
  type ThreadHistoryChain,
} from "./cache-owners/thread-history-cache-owner";
import {
  createFlushOncePredicate,
  executeRealtimeDirtyHandlers,
  REALTIME_PROJECT_CHANGE_REGISTRY,
  REALTIME_SYSTEM_CHANGE_REGISTRY,
  REALTIME_THREAD_CHANGE_REGISTRY,
} from "./cache-owners/realtime-cache-registry";
import {
  invalidateRealtimeQueriesAfterServerReconnect,
  invalidateRealtimeQueriesFetchedBeforeInitialConnect,
} from "./cache-owners/system-cache-effects";
import {
  invalidateThreadHistoryRewriteQueries,
  removeThreadScopedQueries,
} from "./cache-owners/mutation-cache-effects";
import { applyProjectDeleteResult } from "./cache-owners/project-cache-owner";
import {
  sidebarNavigationQueryKey,
  threadDetailBootstrapQueryKey,
  threadHistoryQueryKey,
  threadQueryKey,
  threadsQueryKey,
  threadTimelineQueryKey,
} from "./queries/query-keys";

function historyChain(validatedAt: number[] = [1]): ThreadHistoryChain {
  return {
    surfaceKey: "default",
    pages: validatedAt.map((timestamp) =>
      createThreadHistoryPage(
        makeThreadTimelineResponse({ maxSeq: 1 }),
        null,
        timestamp,
      ),
    ),
  };
}

function historyKey(threadId: string) {
  return threadHistoryQueryKey(threadId, "default", 20);
}

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
}

function applyThreadChange(client: QueryClient, change: ThreadChangeKind) {
  executeRealtimeDirtyHandlers({
    context: {
      queryClient: client,
      threadId: "thread-1",
      projectId: "project-1",
      backgroundActivityChanged: undefined,
      eventTypes: ["turn/completed"] as const,
      flushOnce: createFlushOncePredicate(),
      hasPendingInteraction: undefined,
      statusChange: undefined,
    },
    handlers: REALTIME_THREAD_CHANGE_REGISTRY[change].dirty,
  });
}

describe("thread history cache effects", () => {
  it.each([
    "history-rewritten",
    "title-changed",
    "environment-changed",
  ] as const)(
    "refreshes history and latest data after %s without clearing readable rows",
    async (change) => {
      const client = queryClient();
      const data = historyChain();
      client.setQueryData(historyKey("thread-1"), data);
      client.setQueryData(
        threadTimelineQueryKey("thread-1"),
        data.pages[0]!.response,
      );
      const generation = getThreadHistoryGeneration(client, "thread-1");

      applyThreadChange(client, change);

      expect(generation.request).toBe(1);
      await vi.waitFor(() =>
        expect(
          client.getQueryState(historyKey("thread-1"))?.isInvalidated,
        ).toBe(true),
      );
      expect(client.getQueryData(historyKey("thread-1"))).toBe(data);
      expect(
        client.getQueryState(threadTimelineQueryKey("thread-1"))?.isInvalidated,
      ).toBe(true);
      client.clear();
    },
  );

  it("keeps completed turns from rebuilding active historical pages", async () => {
    const client = queryClient();
    const data = historyChain();
    const key = historyKey("thread-1");
    client.setQueryData(key, data);
    const fetchHistory = vi.fn(async () => data);
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: fetchHistory,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    const generation = getThreadHistoryGeneration(client, "thread-1");

    applyThreadChange(client, "events-appended");
    await Promise.resolve();

    expect(fetchHistory).not.toHaveBeenCalled();
    expect(generation.request).toBe(0);
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    unsubscribe();
    client.clear();
  });

  it("invalidates retained history for rendering configuration changes and local rewrites", async () => {
    const client = queryClient();
    client.setQueryData(historyKey("thread-1"), historyChain());
    client.setQueryData(historyKey("thread-2"), historyChain());
    const first = getThreadHistoryGeneration(client, "thread-1");
    const second = getThreadHistoryGeneration(client, "thread-2");

    invalidateThreadHistoryRewriteQueries({
      queryClient: client,
      threadId: "thread-1",
    });
    await vi.waitFor(() =>
      expect(client.getQueryState(historyKey("thread-1"))?.isInvalidated).toBe(
        true,
      ),
    );
    expect(client.getQueryState(historyKey("thread-2"))?.isInvalidated).toBe(
      false,
    );
    expect(first.request).toBe(1);

    executeRealtimeDirtyHandlers({
      context: { queryClient: client },
      handlers: REALTIME_SYSTEM_CHANGE_REGISTRY["config-changed"].dirty,
    });

    await vi.waitFor(() =>
      expect(client.getQueryState(historyKey("thread-2"))?.isInvalidated).toBe(
        true,
      ),
    );
    expect(second.request).toBe(1);
    client.clear();
  });

  it.each(["reconnect", "initial connect"] as const)(
    "uses page validation times on %s even after a newer page was appended",
    async (event) => {
      const client = queryClient();
      const timestamp = Date.now();
      const staleKey = historyKey("thread-1");
      const freshKey = historyKey("thread-2");
      client.setQueryData(
        staleKey,
        historyChain([timestamp - 500, timestamp + 500]),
        { updatedAt: timestamp + 500 },
      );
      client.setQueryData(freshKey, historyChain([timestamp + 500]), {
        updatedAt: timestamp + 500,
      });

      if (event === "reconnect") {
        invalidateRealtimeQueriesAfterServerReconnect({
          queryClient: client,
          disconnectedAt: timestamp,
        });
      } else {
        invalidateRealtimeQueriesFetchedBeforeInitialConnect({
          queryClient: client,
          connectedAt: timestamp,
        });
      }

      await vi.waitFor(() =>
        expect(client.getQueryState(staleKey)?.isInvalidated).toBe(true),
      );
      expect(client.getQueryState(freshKey)?.isInvalidated).toBe(false);
      client.clear();
    },
  );

  it.each(["local", "realtime"] as const)(
    "purges only deleted thread history through %s deletion",
    (source) => {
      const client = queryClient();
      client.setQueryData(historyKey("thread-1"), historyChain());
      client.setQueryData(historyKey("thread-2"), historyChain());
      const generation = getThreadHistoryGeneration(client, "thread-1");

      if (source === "local")
        removeThreadScopedQueries({
          queryClient: client,
          threadId: "thread-1",
        });
      else applyThreadChange(client, "thread-deleted");

      expect(client.getQueryData(historyKey("thread-1"))).toBeUndefined();
      expect(client.getQueryData(historyKey("thread-2"))).toBeDefined();
      expect(generation.eviction).toBe(1);
      expect(generation.blocked).toBe(true);
      client.clear();
    },
  );

  it.each(["local", "realtime"] as const)(
    "targets project history from existing cached ownership during %s deletion",
    (source) => {
      const client = queryClient();
      const affectedIds = ["detail", "bootstrap", "list", "sidebar"];
      for (const id of [...affectedIds, "other"])
        client.setQueryData(historyKey(id), historyChain());
      client.setQueryData(threadQueryKey("detail"), {
        id: "detail",
        projectId: "project-1",
      });
      client.setQueryData(threadDetailBootstrapQueryKey("bootstrap"), {
        id: "bootstrap",
        projectId: "project-1",
      });
      client.setQueryData(threadsQueryKey(), {
        pages: [
          [
            { id: "list", projectId: "project-1" },
            { id: "other", projectId: "project-2" },
          ],
        ],
        pageParams: [null],
      });
      client.setQueryData(sidebarNavigationQueryKey(), {
        projects: [
          {
            id: "project-1",
            threads: [{ id: "sidebar", projectId: "project-1" }],
          },
        ],
        personalProject: { id: "personal", threads: [] },
      });

      if (source === "local") {
        applyProjectDeleteResult({
          queryClient: client,
          projectId: "project-1",
        });
      } else {
        executeRealtimeDirtyHandlers({
          context: { queryClient: client, projectId: "project-1" },
          handlers: REALTIME_PROJECT_CHANGE_REGISTRY["project-deleted"].dirty,
        });
      }

      for (const id of affectedIds) {
        expect(client.getQueryData(historyKey(id))).toBeUndefined();
        expect(getThreadHistoryGeneration(client, id).blocked).toBe(true);
      }
      expect(client.getQueryData(historyKey("other"))).toBeDefined();
      client.clear();
    },
  );
});
