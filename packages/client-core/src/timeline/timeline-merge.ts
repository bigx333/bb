import type {
  ThreadTimelineResponse,
  TimelinePaginationCursor,
  TimelineRow,
} from "@bb/server-contract";
import { isOptimisticTimelineRowId } from "./optimistic-timeline-row.js";

type NullableTimelinePaginationCursor = TimelinePaginationCursor | null;

export interface LoadedTimelineState {
  historySnapshot?: string;
  latestWindowEndSequence: number | null;
  olderCursor: NullableTimelinePaginationCursor;
  rows: TimelineRow[];
  surfaceKey: string;
}

interface BuildLoadedTimelineStateArgs {
  historySnapshot?: string;
  latestWindowEndSequence: number | null;
  latestRows: TimelineRow[];
  olderCursor: NullableTimelinePaginationCursor;
  surfaceKey: string;
}

interface AreTimelinePaginationCursorsEqualArgs {
  left: NullableTimelinePaginationCursor;
  right: NullableTimelinePaginationCursor;
}

interface MergeLatestTimelineRowsArgs {
  latestRows: readonly TimelineRow[];
  latestWindowStartSequence: number;
  loadedRows: TimelineRow[];
}

interface MergeLatestTimelineRowsResult {
  canMerge: boolean;
  rows: TimelineRow[];
}

interface PreserveTimelineRowIdentityArgs {
  nextRows: readonly TimelineRow[];
  previousRows: readonly TimelineRow[];
}

interface AreTimelineRowReferencesEqualArgs {
  left: readonly TimelineRow[];
  right: readonly TimelineRow[];
}

interface PrependOlderTimelineRowsArgs {
  loadedRows: readonly TimelineRow[];
  olderRows: readonly TimelineRow[];
}

interface MergeLoadedTimelineWithLatestArgs {
  current: LoadedTimelineState;
  latestTimeline: ThreadTimelineResponse;
  surfaceKey: string;
}

interface MergeAdvancedSnapshotTimelineRowsArgs {
  current: LoadedTimelineState;
  latestRows: readonly TimelineRow[];
  latestTimeline: ThreadTimelineResponse;
}

interface RecoverLoadedTimelineAfterStaleCursorArgs {
  current: LoadedTimelineState;
  latestTimeline: ThreadTimelineResponse;
  surfaceKey: string;
}

interface BuildLoadedTimelineFromPagesArgs {
  pages: readonly ThreadTimelineResponse[];
  surfaceKey: string;
}

interface ReconcileLoadedTimelineWithHistoryPagesArgs extends BuildLoadedTimelineFromPagesArgs {
  current: LoadedTimelineState;
}

export function resolveLoadedTimelineSurfaceKey(
  baseSurfaceKey: string,
  latestTimeline:
    | Pick<
        ThreadTimelineResponse,
        "completedTurnDisplay" | "contextBoundarySeq"
      >
    | undefined,
): string {
  if (latestTimeline === undefined) {
    return baseSurfaceKey;
  }
  const displaySurfaceKey = `${baseSurfaceKey}:completed-turns:${latestTimeline.completedTurnDisplay}`;
  return latestTimeline.contextBoundarySeq === null
    ? displaySurfaceKey
    : `${displaySurfaceKey}:context-boundary:${latestTimeline.contextBoundarySeq}`;
}

export function buildLoadedTimelineState({
  historySnapshot,
  latestWindowEndSequence,
  latestRows,
  olderCursor,
  surfaceKey,
}: BuildLoadedTimelineStateArgs): LoadedTimelineState {
  return {
    historySnapshot,
    latestWindowEndSequence,
    olderCursor,
    rows: latestRows,
    surfaceKey,
  };
}

export function areTimelinePaginationCursorsEqual({
  left,
  right,
}: AreTimelinePaginationCursorsEqualArgs): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.anchorSeq === right.anchorSeq && left.anchorId === right.anchorId;
}

function appendTimelineRowsPreservingOrder(
  target: TimelineRow[],
  rows: readonly TimelineRow[],
): void {
  const seenIds = new Set(target.map((row) => row.id));
  for (const row of rows) {
    if (seenIds.has(row.id)) {
      continue;
    }
    seenIds.add(row.id);
    target.push(row);
  }
}

function timelineRowIdentitySignature(row: TimelineRow): string {
  const turnRequest =
    row.kind === "conversation" && row.role === "user" ? row.turnRequest : null;
  return [
    row.kind,
    row.id,
    row.threadId,
    row.turnId ?? "<null>",
    row.sourceSeqStart,
    row.sourceSeqEnd,
    row.startedAt,
    row.createdAt,
    turnRequest?.isGrouped,
    turnRequest?.kind,
    turnRequest?.status,
  ].join("\u001f");
}

function preserveTimelineRowIdentity({
  nextRows,
  previousRows,
}: PreserveTimelineRowIdentityArgs): TimelineRow[] {
  const previousRowsById = new Map(previousRows.map((row) => [row.id, row]));
  return nextRows.map((row) => {
    const previous = previousRowsById.get(row.id);
    if (previous === row) return row;
    if (
      previous &&
      timelineRowIdentitySignature(previous) ===
        timelineRowIdentitySignature(row) &&
      JSON.stringify(previous) === JSON.stringify(row)
    ) {
      return previous;
    }
    return row;
  });
}

function areTimelineRowReferencesEqual({
  left,
  right,
}: AreTimelineRowReferencesEqualArgs): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => row === right[index]);
}

function joinOlderTimelineRowChildren(
  older: TimelineRow,
  loaded: TimelineRow,
): TimelineRow {
  if (
    older.kind === "turn" &&
    loaded.kind === "turn" &&
    older.children !== null &&
    loaded.children !== null
  ) {
    const children = prependOlderTimelineRows({
      olderRows: older.children,
      loadedRows: loaded.children,
    });
    if (
      areTimelineRowReferencesEqual({ left: children, right: loaded.children })
    ) {
      return loaded;
    }
    return {
      ...loaded,
      children,
    };
  }
  if (
    older.kind === "work" &&
    older.workKind === "delegation" &&
    loaded.kind === "work" &&
    loaded.workKind === "delegation"
  ) {
    const childRows = prependOlderTimelineRows({
      olderRows: older.childRows,
      loadedRows: loaded.childRows,
    });
    if (
      areTimelineRowReferencesEqual({
        left: childRows,
        right: loaded.childRows,
      })
    ) {
      return loaded;
    }
    return {
      ...loaded,
      childRows,
    };
  }
  return loaded;
}

export function prependOlderTimelineRows({
  loadedRows,
  olderRows,
}: PrependOlderTimelineRowsArgs): TimelineRow[] {
  const uniqueLoadedRows: TimelineRow[] = [];
  appendTimelineRowsPreservingOrder(uniqueLoadedRows, loadedRows);
  const loadedIds = new Set(uniqueLoadedRows.map((row) => row.id));
  const olderById = new Map<string, TimelineRow>();
  const rows: TimelineRow[] = [];
  for (const row of olderRows) {
    if (olderById.has(row.id)) {
      continue;
    }
    olderById.set(row.id, row);
    if (!loadedIds.has(row.id)) {
      rows.push(row);
    }
  }
  for (const loaded of uniqueLoadedRows) {
    const older = olderById.get(loaded.id);
    rows.push(
      older === undefined
        ? loaded
        : joinOlderTimelineRowChildren(older, loaded),
    );
  }
  return rows;
}

export function mergeLatestTimelineRows({
  latestRows,
  latestWindowStartSequence,
  loadedRows: retainedRows,
}: MergeLatestTimelineRowsArgs): MergeLatestTimelineRowsResult {
  const loadedRows = retainedRows.some((row) =>
    isOptimisticTimelineRowId(row.id),
  )
    ? retainedRows.filter((row) => !isOptimisticTimelineRowId(row.id))
    : retainedRows;

  const identityPreservedLatestRows = preserveTimelineRowIdentity({
    nextRows: latestRows,
    previousRows: loadedRows,
  });

  if (loadedRows.length === 0) {
    return {
      canMerge: true,
      rows: identityPreservedLatestRows,
    };
  }

  const latestRowsById = new Map(
    identityPreservedLatestRows.map((row) => [row.id, row]),
  );
  const rowsToRetain = loadedRows.filter(
    (row) =>
      row.sourceSeqEnd < latestWindowStartSequence ||
      latestRowsById.has(row.id),
  );
  const retainedRowIds = new Set(rowsToRetain.map((row) => row.id));
  const loadedCommonIds = rowsToRetain.flatMap((row) =>
    latestRowsById.has(row.id) ? [row.id] : [],
  );
  const latestCommonIds = identityPreservedLatestRows.flatMap((row) =>
    retainedRowIds.has(row.id) ? [row.id] : [],
  );
  if (
    loadedCommonIds.length !== latestCommonIds.length ||
    loadedCommonIds.some((id, index) => id !== latestCommonIds[index])
  ) {
    return { canMerge: false, rows: identityPreservedLatestRows };
  }

  const rowsBeforeSharedId = new Map<string, TimelineRow[]>();
  let pendingRows: TimelineRow[] = [];
  for (const row of identityPreservedLatestRows) {
    if (!retainedRowIds.has(row.id)) {
      pendingRows.push(row);
      continue;
    }
    if (pendingRows.length > 0) {
      rowsBeforeSharedId.set(row.id, pendingRows);
      pendingRows = [];
    }
  }

  const rows: TimelineRow[] = [];
  for (const row of rowsToRetain) {
    const rowsBefore = rowsBeforeSharedId.get(row.id);
    if (rowsBefore) {
      rows.push(...rowsBefore);
    }
    rows.push(latestRowsById.get(row.id) ?? row);
  }
  rows.push(...pendingRows);
  if (areTimelineRowReferencesEqual({ left: loadedRows, right: rows })) {
    return {
      canMerge: true,
      rows: loadedRows,
    };
  }

  return {
    canMerge: true,
    rows,
  };
}

function timelineWindowStartSequence(timeline: ThreadTimelineResponse): number {
  return timeline.timelinePage.olderCursor?.anchorSeq ?? 0;
}

function timelineWindowsAreContiguous(
  current: LoadedTimelineState,
  latestTimeline: ThreadTimelineResponse,
): boolean {
  return (
    current.latestWindowEndSequence !== null &&
    latestTimeline.maxSeq >= current.latestWindowEndSequence &&
    timelineWindowStartSequence(latestTimeline) <=
      current.latestWindowEndSequence + 1
  );
}

function mergeLoadedTimelineOlderCursor(
  current: NullableTimelinePaginationCursor,
  latest: NullableTimelinePaginationCursor,
): NullableTimelinePaginationCursor {
  if (current === null || latest === null) {
    return null;
  }
  return latest.anchorSeq < current.anchorSeq ? latest : current;
}

function mergeAdvancedSnapshotTimelineRows({
  current,
  latestRows,
  latestTimeline,
}: MergeAdvancedSnapshotTimelineRowsArgs): MergeLatestTimelineRowsResult {
  const latestWindowStartSequence = timelineWindowStartSequence(latestTimeline);
  const { olderRowsSourceSeqEnd } = latestTimeline.timelinePage;
  if (
    olderRowsSourceSeqEnd === undefined ||
    (olderRowsSourceSeqEnd !== null &&
      olderRowsSourceSeqEnd > (current.latestWindowEndSequence ?? 0))
  ) {
    return { canMerge: false, rows: [...latestRows] };
  }
  if (latestTimeline.timelinePage.olderCursor === null) {
    return mergeLatestTimelineRows({
      latestRows,
      latestWindowStartSequence,
      loadedRows: current.rows,
    });
  }
  const loadedRows = current.rows.filter(
    (row) => !isOptimisticTimelineRowId(row.id),
  );
  const latestRowIds = new Set(latestRows.map((row) => row.id));
  const firstCoveredIndex = loadedRows.findIndex((row) =>
    latestRowIds.has(row.id),
  );
  if (firstCoveredIndex === -1) {
    return latestWindowStartSequence > (current.latestWindowEndSequence ?? 0)
      ? { canMerge: true, rows: [...loadedRows, ...latestRows] }
      : { canMerge: false, rows: [...latestRows] };
  }
  const coveredMerge = mergeLatestTimelineRows({
    latestRows,
    latestWindowStartSequence: 0,
    loadedRows: loadedRows.slice(firstCoveredIndex),
  });
  if (!coveredMerge.canMerge) {
    return coveredMerge;
  }
  const rows = [
    ...loadedRows.slice(0, firstCoveredIndex),
    ...coveredMerge.rows,
  ];
  return {
    canMerge: true,
    rows: areTimelineRowReferencesEqual({ left: current.rows, right: rows })
      ? current.rows
      : rows,
  };
}

function loadedTimelineStateFromLatest(
  latestTimeline: ThreadTimelineResponse,
  surfaceKey: string,
  rows: TimelineRow[] = latestTimeline.rows,
): LoadedTimelineState {
  return {
    historySnapshot: latestTimeline.timelinePage.historySnapshot,
    latestWindowEndSequence: latestTimeline.maxSeq,
    olderCursor: latestTimeline.timelinePage.olderCursor,
    rows,
    surfaceKey,
  };
}

export function tryMergeLoadedTimelineWithLatest({
  current,
  latestTimeline,
  surfaceKey,
}: MergeLoadedTimelineWithLatestArgs): LoadedTimelineState | null {
  const latestHistorySnapshot = latestTimeline.timelinePage.historySnapshot;
  if (
    current.surfaceKey !== surfaceKey ||
    (current.historySnapshot === undefined) !==
      (latestHistorySnapshot === undefined) ||
    !timelineWindowsAreContiguous(current, latestTimeline)
  ) {
    return null;
  }

  const currentRowsById = new Map(current.rows.map((row) => [row.id, row]));
  const latestRows =
    current.historySnapshot === undefined
      ? latestTimeline.rows
      : latestTimeline.rows.map((row) => {
          const loaded = currentRowsById.get(row.id);
          return loaded === undefined
            ? row
            : prependOlderTimelineRows({
                olderRows: [loaded],
                loadedRows: [row],
              })[0]!;
        });
  const latestMerge =
    current.historySnapshot === latestHistorySnapshot
      ? mergeLatestTimelineRows({
          latestRows,
          latestWindowStartSequence:
            timelineWindowStartSequence(latestTimeline),
          loadedRows: current.rows,
        })
      : mergeAdvancedSnapshotTimelineRows({
          current,
          latestRows,
          latestTimeline,
        });
  if (!latestMerge.canMerge) {
    return null;
  }

  return {
    ...current,
    historySnapshot: latestHistorySnapshot,
    latestWindowEndSequence: latestTimeline.maxSeq,
    olderCursor: mergeLoadedTimelineOlderCursor(
      current.olderCursor,
      latestTimeline.timelinePage.olderCursor,
    ),
    rows: latestMerge.rows,
  };
}

export function mergeLoadedTimelineWithLatest(
  args: MergeLoadedTimelineWithLatestArgs,
): LoadedTimelineState {
  return (
    tryMergeLoadedTimelineWithLatest(args) ??
    loadedTimelineStateFromLatest(args.latestTimeline, args.surfaceKey)
  );
}

export function buildLoadedTimelineFromPages({
  pages,
  surfaceKey,
}: BuildLoadedTimelineFromPagesArgs): LoadedTimelineState | null {
  const latest = pages[0];
  if (latest === undefined || latest.timelinePage.kind !== "latest") {
    return null;
  }
  let rows = latest.rows;
  let previous = latest;
  for (const page of pages.slice(1)) {
    const previousCursor = previous.timelinePage.olderCursor;
    const nextCursor = page.timelinePage.olderCursor;
    const previousContent = previous.timelinePage.contentPage;
    const nextContent = page.timelinePage.contentPage;
    if (
      previousCursor === null ||
      page.timelinePage.kind !== "older" ||
      page.timelinePage.historySnapshot !==
        latest.timelinePage.historySnapshot ||
      page.completedTurnDisplay !== latest.completedTurnDisplay ||
      page.contextBoundarySeq !== latest.contextBoundarySeq ||
      page.maxSeq !== latest.maxSeq ||
      (nextCursor !== null &&
        (nextCursor.anchorSeq > previousCursor.anchorSeq ||
          areTimelinePaginationCursorsEqual({
            left: previousCursor,
            right: nextCursor,
          }))) ||
      (previousContent !== undefined &&
        previousContent.start > 0 &&
        nextContent?.anchorSeq === previousContent.anchorSeq &&
        (nextContent.end !== previousContent.start ||
          nextContent.total !== previousContent.total))
    ) {
      return null;
    }
    rows = prependOlderTimelineRows({ loadedRows: rows, olderRows: page.rows });
    previous = page;
  }
  return {
    ...loadedTimelineStateFromLatest(latest, surfaceKey, rows),
    olderCursor: previous.timelinePage.olderCursor,
  };
}

function timelineRowChildren(row: TimelineRow): readonly TimelineRow[] | null {
  if (row.kind === "turn" && row.children?.length) return row.children;
  if (
    row.kind === "work" &&
    row.workKind === "delegation" &&
    row.childRows.length
  ) {
    return row.childRows;
  }
  return null;
}

function timelineRowWithChildren(
  row: TimelineRow,
  children: TimelineRow[],
): TimelineRow {
  if (row.kind === "turn") return { ...row, children };
  if (row.kind === "work" && row.workKind === "delegation") {
    return { ...row, childRows: children };
  }
  return row;
}

function preserveNestedTimelineRowIdentity({
  nextRows,
  previousRows,
}: PreserveTimelineRowIdentityArgs): TimelineRow[] {
  const previousById = new Map(previousRows.map((row) => [row.id, row]));
  return preserveTimelineRowIdentity({
    previousRows,
    nextRows: nextRows.map((row) => {
      const previous = previousById.get(row.id);
      if (previous === undefined || previous === row) return row;
      const nextChildren = timelineRowChildren(row);
      const previousChildren = timelineRowChildren(previous);
      if (nextChildren === null || previousChildren === null) return row;
      const children = preserveNestedTimelineRowIdentity({
        nextRows: nextChildren,
        previousRows: previousChildren,
      });
      return areTimelineRowReferencesEqual({
        left: nextChildren,
        right: children,
      })
        ? row
        : timelineRowWithChildren(row, children);
    }),
  });
}

function retainTimelinePrefixBeforeLeaf(
  rows: readonly TimelineRow[],
  leafId: string,
  contentStart: number,
  anchorSeq: number,
): TimelineRow[] | null {
  let reachedBoundary = false;
  let retainedContentLeaves = 0;
  const retain = (
    items: readonly TimelineRow[],
    segmentSequence?: number,
  ): TimelineRow[] =>
    items.flatMap((row) => {
      if (reachedBoundary || isOptimisticTimelineRowId(row.id)) return [];
      const sequence = segmentSequence ?? row.sourceSeqStart;
      const children = timelineRowChildren(row);
      if (children !== null) {
        const retained = retain(children, sequence);
        if (retained.length === 0) return [];
        return [
          areTimelineRowReferencesEqual({ left: children, right: retained })
            ? row
            : timelineRowWithChildren(row, retained),
        ];
      }
      if (row.id === leafId) {
        reachedBoundary = true;
        return [];
      }
      if (sequence >= anchorSeq) retainedContentLeaves += 1;
      return [row];
    });
  const retained = retain(rows);
  return reachedBoundary && retainedContentLeaves === contentStart
    ? retained
    : null;
}

function firstTimelineLeaf(
  rows: readonly TimelineRow[],
): TimelineRow | undefined {
  const first = rows[0];
  if (first === undefined) return undefined;
  const children = timelineRowChildren(first);
  return children === null ? first : firstTimelineLeaf(children);
}

export function reconcileLoadedTimelineWithHistoryPages({
  current,
  pages,
  surfaceKey,
}: ReconcileLoadedTimelineWithHistoryPagesArgs): LoadedTimelineState | null {
  const replacement = buildLoadedTimelineFromPages({ pages, surfaceKey });
  const oldest = pages.at(-1);
  const latest = pages[0];
  if (replacement === null || oldest === undefined || latest === undefined)
    return null;
  if (current.rows.length === 0) return replacement;
  if (current.surfaceKey !== surfaceKey) return null;
  const combined = {
    ...latest,
    rows: replacement.rows,
    timelinePage: { ...oldest.timelinePage, kind: "latest" as const },
  };
  if (
    (current.historySnapshot === undefined) !==
      (replacement.historySnapshot === undefined) ||
    !timelineWindowsAreContiguous(current, combined)
  ) {
    return null;
  }
  const { contentPage, olderRowsSourceSeqEnd } = oldest.timelinePage;
  const partialBoundary = contentPage !== undefined && contentPage.start > 0;
  const coversCurrent =
    replacement.olderCursor === null ||
    (!partialBoundary &&
      current.olderCursor !== null &&
      replacement.olderCursor.anchorSeq <= current.olderCursor.anchorSeq);
  if (
    !coversCurrent &&
    current.historySnapshot !== replacement.historySnapshot &&
    (olderRowsSourceSeqEnd === undefined ||
      (olderRowsSourceSeqEnd !== null &&
        olderRowsSourceSeqEnd > (current.latestWindowEndSequence ?? 0)))
  ) {
    return null;
  }
  let rows = replacement.rows;
  if (!coversCurrent && partialBoundary) {
    if (
      current.olderCursor !== null &&
      current.olderCursor.anchorSeq >= contentPage.anchorSeq
    ) {
      return null;
    }
    const firstLeaf = firstTimelineLeaf(rows);
    if (firstLeaf === undefined) return null;
    const prefix = retainTimelinePrefixBeforeLeaf(
      current.rows,
      firstLeaf.id,
      contentPage.start,
      contentPage.anchorSeq,
    );
    if (prefix === null) return null;
    rows = prependOlderTimelineRows({ olderRows: prefix, loadedRows: rows });
  } else if (!coversCurrent) {
    const merge = mergeLatestTimelineRows({
      latestRows: rows,
      loadedRows: current.rows,
      latestWindowStartSequence: timelineWindowStartSequence(combined),
    });
    if (!merge.canMerge) return null;
    rows = merge.rows;
  }
  rows = preserveNestedTimelineRowIdentity({
    nextRows: rows,
    previousRows: current.rows,
  });
  return {
    ...replacement,
    olderCursor: coversCurrent ? replacement.olderCursor : current.olderCursor,
    rows: areTimelineRowReferencesEqual({ left: current.rows, right: rows })
      ? current.rows
      : rows,
  };
}

export function recoverLoadedTimelineAfterStaleCursor({
  current,
  latestTimeline,
  surfaceKey,
}: RecoverLoadedTimelineAfterStaleCursorArgs): LoadedTimelineState {
  if (
    current.surfaceKey !== surfaceKey ||
    current.historySnapshot !== latestTimeline.timelinePage.historySnapshot
  ) {
    return loadedTimelineStateFromLatest(latestTimeline, surfaceKey);
  }

  const latestMerge = mergeLatestTimelineRows({
    latestRows: latestTimeline.rows,
    latestWindowStartSequence: timelineWindowStartSequence(latestTimeline),
    loadedRows: current.rows,
  });
  if (!latestMerge.canMerge) {
    return loadedTimelineStateFromLatest(latestTimeline, surfaceKey);
  }

  return loadedTimelineStateFromLatest(
    latestTimeline,
    surfaceKey,
    latestMerge.rows,
  );
}
