import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  events,
  retainedEventOutputs,
  threadPruningCursors,
} from "../../src/schema.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { advanceThreadPruning } from "../../src/data/thread-pruning.js";
import { advanceCompletedItemCompaction } from "../../src/data/completed-item-compaction.js";
import { expandSelectedCompletedItemRows } from "../../src/data/completed-item-history.js";
import {
  listStoredEventRows,
  getHighWaterMarks,
  deleteThreadEventSuffixInTransaction,
} from "../../src/data/events.js";
import { getThreadEventRewriteGeneration } from "../../src/data/event-rewrite-generation.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "compaction" });
  const { project } = createProject(db, noopNotifier, {
    name: "compaction",
    source: { type: "local_path", hostId: host.id, path: "/tmp/compaction" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const seed = (
    sequence: number,
    values: Partial<typeof events.$inferInsert>,
  ) =>
    db
      .insert(events)
      .values({
        id: `event-${sequence}`,
        threadId: thread.id,
        sequence,
        scopeKind: "turn",
        turnId: "turn",
        providerThreadId: "provider",
        type: "item/started",
        data: "{}",
        createdAt: sequence * 100,
        ...values,
      })
      .run();
  const item = {
    id: "message",
    type: "agentMessage",
    text: "lossless assistant text",
  };
  seed(1, { type: "turn/started", data: "{}" });
  seed(2, {
    itemId: item.id,
    itemKind: "agentMessage",
    data: JSON.stringify({ item: { ...item, text: "" } }),
  });
  seed(3, {
    type: "item/agentMessage/delta",
    itemId: item.id,
    data: JSON.stringify({ itemId: item.id, delta: "lossless assistant text" }),
  });
  seed(5, {
    type: "item/completed",
    itemId: item.id,
    itemKind: "agentMessage",
    data: JSON.stringify({ item }),
  });
  seed(6, {
    type: "turn/completed",
    data: JSON.stringify({ status: "completed" }),
  });
  const rows = () => listStoredEventRows(db, { threadId: thread.id });
  const advance = () => advanceThreadPruning(db, "completed-items");
  return { db, thread, seed, rows, advance };
}

function normalized(rows: ReturnType<ReturnType<typeof setup>["rows"]>) {
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

describe("completed items at first lifecycle position", () => {
  it("preserves completion ownership, timestamps, lossless history and highwater through atomic progress", () => {
    const f = setup();
    try {
      const before = f.rows();
      const generation = getThreadEventRewriteGeneration(f.thread.id);
      f.db
        .insert(retainedEventOutputs)
        .values({
          eventId: "event-5",
          outputPath: "resultText",
          value: "retained",
          expiresAt: 999999,
        })
        .run();
      const result = f.advance();
      expect(result.removed).toBe(2);
      const owner = f.rows().find((row) => row.id === "event-5");
      expect(owner).toMatchObject({
        sequence: 2,
        createdAt: 500,
        type: "item/completed",
        data: before.find((row) => row.id === "event-5")!.data,
      });
      expect(
        normalized(expandSelectedCompletedItemRows(f.db, f.rows())),
      ).toEqual(normalized(before));
      expect(getHighWaterMarks(f.db, [f.thread.id])[f.thread.id]).toBe(6);
      expect(f.db.select().from(retainedEventOutputs).all()).toHaveLength(1);
      expect(getThreadEventRewriteGeneration(f.thread.id)).toBe(generation + 1);
      expect(f.db.select().from(threadPruningCursors).all()).toHaveLength(1);
      expect(f.advance().removed).toBe(0);
    } finally {
      f.db.$client.close();
    }
  });

  it.each(["user", "context"])(
    "leaves %s boundary crossings ordinary so edit suffix deletion remains valid",
    (boundary) => {
      const f = setup();
      try {
        f.seed(4, {
          type:
            boundary === "user" ? "client/turn/requested" : "system/operation",
          scopeKind: "thread",
          turnId: null,
          data: JSON.stringify(
            boundary === "user"
              ? { initiator: "user" }
              : { operation: "context_clear", status: "completed" },
          ),
        });
        expect(f.advance().removed).toBe(0);
        f.db.transaction((tx) =>
          deleteThreadEventSuffixInTransaction(tx, {
            threadId: f.thread.id,
            cutoffSequence: 4,
            oldMaxSequence: 6,
          }),
        );
        expect(f.rows().map((row) => row.sequence)).toEqual([1, 2, 3]);
      } finally {
        f.db.$client.close();
      }
    },
  );

  it.each(["unsettled", "duplicate", "late", "malformed", "oversized"])(
    "skips %s lifecycles",
    (reason) => {
      const f = setup();
      try {
        if (reason === "unsettled")
          f.db.delete(events).where(eq(events.id, "event-6")).run();
        if (reason === "duplicate")
          f.seed(4, {
            type: "item/completed",
            itemId: "message",
            itemKind: "agentMessage",
          });
        if (reason === "late")
          f.seed(7, { type: "item/agentMessage/delta", itemId: "message" });
        if (reason === "malformed")
          f.db
            .update(events)
            .set({ data: "invalid" })
            .where(eq(events.id, "event-3"))
            .run();
        if (reason === "oversized")
          f.db
            .update(events)
            .set({
              data: JSON.stringify({
                itemId: "message",
                delta: "x".repeat(1024 * 1024),
              }),
            })
            .where(eq(events.id, "event-3"))
            .run();
        const before = f.rows();
        expect(f.advance().removed).toBe(0);
        expect(f.rows()).toEqual(before);
      } finally {
        f.db.$client.close();
      }
    },
  );

  it("rolls back moved owners and source deletion together", () => {
    const f = setup();
    try {
      const before = f.rows();
      expect(() =>
        f.db.transaction((tx) => {
          expect(
            advanceCompletedItemCompaction(tx, {
              threadId: f.thread.id,
              afterSequence: 0,
              throughSequence: 6,
              limit: 32,
            }).removed,
          ).toBe(2);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(f.rows()).toEqual(before);
    } finally {
      f.db.$client.close();
    }
  });

  it("keeps later arrivals ordinary and reconstructs history after completion output mutation", () => {
    const f = setup();
    try {
      const before = f.rows();
      expect(f.advance().removed).toBe(2);
      f.db
        .update(events)
        .set({
          data: JSON.stringify({
            item: {
              id: "message",
              type: "agentMessage",
              text: "lossless assistant text",
              resultText: "expired",
            },
          }),
        })
        .where(eq(events.id, "event-5"))
        .run();
      f.seed(7, {
        type: "item/agentMessage/delta",
        itemId: "message",
        data: JSON.stringify({ itemId: "message", delta: "late text" }),
      });
      for (let i = 0; i < 10; i++)
        advanceThreadPruning(f.db, { threadId: f.thread.id });
      const expanded = expandSelectedCompletedItemRows(f.db, f.rows());
      expect(normalized(expanded.filter((row) => row.sequence <= 3))).toEqual(
        normalized(before.filter((row) => row.sequence <= 3)),
      );
      expect(expanded.find((row) => row.sequence === 7)).toBeDefined();
    } finally {
      f.db.$client.close();
    }
  });
  it.each([
    { output: "kept output", delta: "kept", start: true, removed: 2 },
    { output: "kept output", delta: "uncontained", start: true, removed: 2 },
    { output: "kept output", delta: "kept", start: false, removed: 1 },
    { output: "kept output", delta: "uncontained", start: false, removed: 0 },
    { output: "", delta: "keep this", start: true, removed: 0 },
  ])(
    "only discards eligible command delta text: %j",
    ({ output, delta, start, removed }) => {
      const f = setup();
      try {
        const item = {
          id: "message",
          type: "commandExecution",
          command: "echo output",
          cwd: "/tmp",
          status: "completed",
          approvalStatus: null,
          aggregatedOutput: output,
        };
        f.db
          .update(events)
          .set({ itemKind: "commandExecution", data: JSON.stringify({ item }) })
          .where(eq(events.id, "event-5"))
          .run();
        f.db
          .update(events)
          .set({
            itemKind: "commandExecution",
            data: JSON.stringify({
              item: { ...item, status: "pending", aggregatedOutput: "" },
            }),
          })
          .where(eq(events.id, "event-2"))
          .run();
        f.db
          .update(events)
          .set({
            type: "item/commandExecution/outputDelta",
            data: JSON.stringify({ itemId: "message", delta }),
          })
          .where(eq(events.id, "event-3"))
          .run();
        if (!start) f.db.delete(events).where(eq(events.id, "event-2")).run();
        expect(f.advance().removed).toBe(removed);
        const expanded = expandSelectedCompletedItemRows(f.db, f.rows());
        expect(
          JSON.parse(expanded.find((row) => row.id === "event-3")!.data).delta,
        ).toBe(removed ? "" : delta);
      } finally {
        f.db.$client.close();
      }
    },
  );

  it("retains both reasoning streams and traverses combined physical records at one-row budgets", () => {
    const f = setup();
    try {
      const item = {
        id: "message",
        type: "reasoning",
        content: ["full reasoning"],
        summary: ["summary"],
      };
      f.db
        .update(events)
        .set({ itemKind: "reasoning", data: JSON.stringify({ item }) })
        .where(eq(events.id, "event-5"))
        .run();
      f.db
        .update(events)
        .set({
          itemKind: "reasoning",
          data: JSON.stringify({ item: { ...item, content: [], summary: [] } }),
        })
        .where(eq(events.id, "event-2"))
        .run();
      f.db
        .update(events)
        .set({
          type: "item/reasoning/textDelta",
          data: JSON.stringify({ itemId: "message", delta: "full reasoning" }),
        })
        .where(eq(events.id, "event-3"))
        .run();
      f.seed(4, {
        type: "item/reasoning/summaryTextDelta",
        itemId: "message",
        data: JSON.stringify({ itemId: "message", delta: "summary" }),
      });
      const before = f.rows();
      expect(f.advance().removed).toBe(3);
      const seen = [];
      let afterSequence = 0;
      for (;;) {
        const page = listStoredEventRows(f.db, {
          threadId: f.thread.id,
          afterSequence,
          limit: 1,
        });
        if (!page.length) break;
        seen.push(...page);
        afterSequence = page[0]!.sequence;
      }
      expect(normalized(expandSelectedCompletedItemRows(f.db, seen))).toEqual(
        normalized(before),
      );
    } finally {
      f.db.$client.close();
    }
  });
});
