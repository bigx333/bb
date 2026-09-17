import { and, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import { events } from "../schema.js";
import {
  decodeCompletedItemHistory,
  parseHistoryPayload,
  restoreHistoryPayload,
} from "../completed-item-history.js";
import type { StoredEventRow } from "./events.js";

export function expandSelectedCompletedItemRows(
  db: DbQueryConnection,
  rows: readonly StoredEventRow[],
  throughSequence = Number.MAX_SAFE_INTEGER,
): StoredEventRow[] {
  const ids = [
    ...new Set(
      rows.filter((row) => row.type === "item/completed").map((row) => row.id),
    ),
  ];
  const histories = new Map<
    string,
    ReturnType<typeof decodeCompletedItemHistory>
  >();
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
      if (row.history !== null)
        histories.set(row.id, decodeCompletedItemHistory(row.history));
    }
  }
  const expanded: StoredEventRow[] = [];
  for (const row of rows) {
    const history = histories.get(row.id);
    if (!history) {
      if (row.sequence <= throughSequence) expanded.push(row);
      continue;
    }
    if (history.sequence <= throughSequence)
      expanded.push({
        ...row,
        sequence: history.sequence,
        createdAt: history.createdAt,
      });
    const payload = history.records.some(
      (record) =>
        record.sharedFields.length > 0 || record.sharedItemFields.length > 0,
    )
      ? parseHistoryPayload(row.data)
      : {};
    for (const record of history.records) {
      if (record.sequence <= throughSequence)
        expanded.push({
          ...row,
          id: record.id,
          sequence: record.sequence,
          createdAt: record.createdAt,
          type: record.type,
          itemKind: record.itemKind,
          data: restoreHistoryPayload(record, payload),
        });
    }
  }
  return expanded.sort((a, b) => a.sequence - b.sequence);
}
