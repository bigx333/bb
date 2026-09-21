import type { ThreadTimelineResponse, TimelineRow } from "@bb/server-contract";

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_RING_SIZE = 4;

interface TimelineLatestRows {
  maxSeq: number;
  rows: readonly TimelineRow[];
}

interface TimelineLatestRowsCache {
  getResponse(
    threadId: string,
    paramsKey: string,
    maxSeq: number,
  ): ThreadTimelineResponse | undefined;
  get(
    threadId: string,
    paramsKey: string,
    maxSeq: number,
  ): TimelineLatestRows | undefined;
  invalidateThread(threadId: string): void;
  set(threadId: string, paramsKey: string, value: ThreadTimelineResponse): void;
  readonly size: number;
}

interface TimelineLatestRowsCacheEntry {
  response: ThreadTimelineResponse;
  ring: TimelineLatestRows[];
  threadId: string;
}

export function createTimelineLatestRowsCache(
  options: { maxEntries?: number; ringSize?: number } = {},
): TimelineLatestRowsCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
  const entries = new Map<string, TimelineLatestRowsCacheEntry>();

  function touch(paramsKey: string, entry: TimelineLatestRowsCacheEntry): void {
    entries.delete(paramsKey);
    entries.set(paramsKey, entry);
  }

  return {
    getResponse(threadId, paramsKey, maxSeq) {
      const entry = entries.get(paramsKey);
      if (
        entry === undefined ||
        entry.threadId !== threadId ||
        entry.response.maxSeq !== maxSeq
      ) {
        return undefined;
      }
      touch(paramsKey, entry);
      return entry.response;
    },
    get(threadId, paramsKey, maxSeq) {
      const entry = entries.get(paramsKey);
      if (entry === undefined || entry.threadId !== threadId) {
        return undefined;
      }
      touch(paramsKey, entry);
      return entry.ring.find((value) => value.maxSeq === maxSeq);
    },
    invalidateThread(threadId) {
      for (const [paramsKey, entry] of entries) {
        if (entry.threadId === threadId) {
          entries.delete(paramsKey);
        }
      }
    },
    set(threadId, paramsKey, value) {
      const cached = entries.get(paramsKey);
      const entry =
        cached?.threadId === threadId
          ? cached
          : { response: value, ring: [], threadId };
      entry.response = value;
      const ring = entry.ring;
      const existingIndex = ring.findIndex(
        (entry) => entry.maxSeq === value.maxSeq,
      );
      if (existingIndex !== -1) {
        ring.splice(existingIndex, 1);
      }
      ring.push({ maxSeq: value.maxSeq, rows: value.rows });
      while (ring.length > ringSize) {
        ring.shift();
      }
      touch(paramsKey, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
