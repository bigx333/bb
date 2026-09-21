import { describe, expect, it } from "vitest";
import type { ThreadTimelineResponse, TimelineRow } from "@bb/server-contract";
import { createTimelineLatestRowsCache } from "../../../src/services/threads/timeline-latest-rows-cache.js";

function rows(label: string): TimelineRow[] {
  return [
    {
      id: `row-${label}`,
      kind: "system",
      threadId: "thr_x",
      turnId: null,
      sourceSeqStart: 0,
      sourceSeqEnd: 0,
      startedAt: 0,
      createdAt: 0,
      systemKind: "debug",
      title: label,
      detail: null,
      status: null,
    },
  ];
}

function response(maxSeq: number, label: string): ThreadTimelineResponse {
  return {
    rows: rows(label),
    maxSeq,
    contextBoundarySeq: null,
    completedTurnDisplay: "collapse",
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

describe("createTimelineLatestRowsCache", () => {
  it("reuses only the most recently stored response at its exact revision", () => {
    const cache = createTimelineLatestRowsCache();
    const first = response(1, "first");
    const second = response(2, "second");
    cache.set("thr_x", "k", first);
    expect(cache.getResponse("thr_x", "k", 1)).toBe(first);
    expect(cache.getResponse("thr_y", "k", 1)).toBeUndefined();
    expect(cache.getResponse("thr_x", "other", 1)).toBeUndefined();
    expect(cache.getResponse("thr_x", "k", 2)).toBeUndefined();
    cache.set("thr_x", "k", second);
    expect(cache.getResponse("thr_x", "k", 1)).toBeUndefined();
    expect(cache.getResponse("thr_x", "k", 2)).toBe(second);
    expect(cache.get("thr_x", "k", 1)?.rows).toBe(first.rows);
  });

  it("keeps a ring of recent revisions per params key and evicts the oldest", () => {
    const cache = createTimelineLatestRowsCache({ ringSize: 3 });
    for (const maxSeq of [1, 2, 3]) {
      cache.set("thr_x", "k", response(maxSeq, `r${maxSeq}`));
    }
    expect(cache.get("thr_x", "k", 1)?.rows).toEqual(rows("r1"));
    expect(cache.get("thr_x", "k", 3)?.rows).toEqual(rows("r3"));

    cache.set("thr_x", "k", response(4, "r4"));
    expect(cache.get("thr_x", "k", 1)).toBeUndefined();
    expect(cache.get("thr_x", "k", 2)?.rows).toEqual(rows("r2"));
    expect(cache.get("thr_x", "k", 4)?.rows).toEqual(rows("r4"));
    expect(cache.get("thr_x", "k", 5)).toBeUndefined();
    expect(cache.get("thr_x", "other", 4)).toBeUndefined();
  });

  it("a repeated set at the same revision refreshes recency without consuming a ring slot", () => {
    const cache = createTimelineLatestRowsCache({ ringSize: 2 });
    cache.set("thr_x", "k", response(1, "r1"));
    cache.set("thr_x", "k", response(2, "r2"));
    cache.set("thr_x", "k", response(1, "r1"));
    cache.set("thr_x", "k", response(1, "r1"));
    expect(cache.get("thr_x", "k", 1)?.rows).toEqual(rows("r1"));
    expect(cache.get("thr_x", "k", 2)?.rows).toEqual(rows("r2"));
    cache.set("thr_x", "k", response(3, "r3"));
    expect(cache.get("thr_x", "k", 2)).toBeUndefined();
    expect(cache.get("thr_x", "k", 1)?.rows).toEqual(rows("r1"));
    expect(cache.get("thr_x", "k", 3)?.rows).toEqual(rows("r3"));
  });

  it("bounds params keys LRU-style; a lookup counts as use", () => {
    const cache = createTimelineLatestRowsCache({ maxEntries: 2 });
    cache.set("thr_a", "a", response(1, "a"));
    cache.set("thr_b", "b", response(1, "b"));
    expect(cache.get("thr_a", "a", 1)).toBeDefined();
    cache.set("thr_c", "c", response(1, "c"));
    expect(cache.size).toBe(2);
    expect(cache.get("thr_b", "b", 1)).toBeUndefined();
    expect(cache.getResponse("thr_b", "b", 1)).toBeUndefined();
    expect(cache.get("thr_a", "a", 1)?.rows).toEqual(rows("a"));
    expect(cache.get("thr_c", "c", 1)?.rows).toEqual(rows("c"));
  });

  it("invalidates only revisions for the rewritten thread", () => {
    const cache = createTimelineLatestRowsCache();
    cache.set("thr_x", "x", response(1, "x"));
    cache.set("thr_y", "y", response(1, "y"));

    cache.invalidateThread("thr_x");

    expect(cache.get("thr_x", "x", 1)).toBeUndefined();
    expect(cache.getResponse("thr_x", "x", 1)).toBeUndefined();
    expect(cache.get("thr_y", "y", 1)?.rows).toEqual(rows("y"));
    expect(cache.size).toBe(1);
  });
});
