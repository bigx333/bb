import type { JsonObject } from "@bb/domain";
import { and, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import { events } from "../schema.js";
import {
  decodeCompletedItemHistory,
  parseHistoryPayload,
  restoreHistoryPayloadObject,
} from "../completed-item-history.js";
import type { StoredEventRow } from "./events.js";

export type ProjectionStoredEventRow = StoredEventRow & {
  parsedData?: JsonObject;
};

function reconstructCompletedItemHistory(metadata: string, ownerData: string) {
  const history = decodeCompletedItemHistory(metadata);
  const payload = parseHistoryPayload(ownerData);
  return {
    sequence: history.sequence,
    createdAt: history.createdAt,
    payload,
    records: history.records.map((record) => {
      const data = restoreHistoryPayloadObject(record, payload);
      return {
        id: record.id,
        sequence: record.sequence,
        createdAt: record.createdAt,
        type: record.type,
        itemKind: record.itemKind,
        data: JSON.stringify(data),
        payload: data,
      };
    }),
  };
}

function expandSelectedCompletedItemRowsInternal(
  db: DbQueryConnection,
  rows: readonly StoredEventRow[],
  throughSequence: number,
  includeParsedData: boolean,
): ProjectionStoredEventRow[] {
  const ids = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.type === "item/completed" &&
            row.completedItemHistory === undefined,
        )
        .map((row) => row.id),
    ),
  ];
  const histories = new Map<string, string>();
  for (const row of rows) {
    if (row.type === "item/completed" && row.completedItemHistory != null)
      histories.set(row.id, row.completedItemHistory);
  }
  if (ids.length > 0) {
    const selected = db
      .select({ id: events.id, history: events.completedItemHistory })
      .from(events)
      .where(
        and(
          inArray(
            events.id,
            sql`(select value from json_each(${JSON.stringify(ids)}))`,
          ),
          isNotNull(events.completedItemHistory),
        ),
      )
      .all();
    for (const row of selected) {
      if (row.history !== null) histories.set(row.id, row.history);
    }
  }
  const expanded: ProjectionStoredEventRow[] = [];
  for (const selectedRow of rows) {
    const { completedItemHistory: _history, ...row } = selectedRow;
    const metadata = histories.get(row.id);
    if (metadata === undefined) {
      if (row.sequence <= throughSequence) expanded.push(row);
      continue;
    }
    const history = reconstructCompletedItemHistory(metadata, row.data);
    if (history.sequence <= throughSequence)
      expanded.push({
        ...row,
        sequence: history.sequence,
        createdAt: history.createdAt,
        ...(includeParsedData ? { parsedData: history.payload } : {}),
      });
    for (const record of history.records) {
      if (record.sequence <= throughSequence)
        expanded.push({
          ...row,
          id: record.id,
          sequence: record.sequence,
          createdAt: record.createdAt,
          type: record.type,
          itemKind: record.itemKind,
          data: record.data,
          ...(includeParsedData ? { parsedData: record.payload } : {}),
        });
    }
  }
  return expanded.sort((a, b) => a.sequence - b.sequence);
}

export function expandSelectedCompletedItemRows(
  db: DbQueryConnection,
  rows: readonly StoredEventRow[],
  throughSequence = Number.MAX_SAFE_INTEGER,
): StoredEventRow[] {
  return expandSelectedCompletedItemRowsInternal(
    db,
    rows,
    throughSequence,
    false,
  );
}

export function expandSelectedCompletedItemRowsForProjection(
  db: DbQueryConnection,
  rows: readonly StoredEventRow[],
  throughSequence = Number.MAX_SAFE_INTEGER,
): ProjectionStoredEventRow[] {
  return expandSelectedCompletedItemRowsInternal(
    db,
    rows,
    throughSequence,
    true,
  );
}
