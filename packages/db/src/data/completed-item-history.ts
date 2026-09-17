import { inArray } from "drizzle-orm";
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
  for (let offset = 0; offset < ids.length; offset += 250) {
    const selected = db
      .select({ id: events.id, history: events.completedItemHistory })
      .from(events)
      .where(inArray(events.id, ids.slice(offset, offset + 250)))
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
    const payload = parseHistoryPayload(row.data);
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
