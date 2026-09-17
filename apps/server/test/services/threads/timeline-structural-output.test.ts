import { describe, expect, it } from "vitest";
import { turnScope, type Thread } from "@bb/domain";
import {
  createConnection,
  createProject,
  createThread,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import {
  buildThreadTimelineWithProfile,
  buildTimelineTurnSummaryDetails,
} from "../../../src/services/threads/timeline.js";

function fixture() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
    status: "idle",
  });
  let sequence = 0;
  const add = (
    type: Parameters<typeof insertEvents>[2][number]["type"],
    data: object,
    itemId: string | null = null,
    itemKind: "commandExecution" | "agentMessage" | null = null,
  ) => {
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        providerThreadId: "provider",
        scope: turnScope("turn"),
        sequence: ++sequence,
        type,
        data: JSON.stringify(data),
        itemId,
        itemKind,
        parentToolCallId: null,
      },
    ]);
  };
  const command = (id: string, output: string) => ({
    item: {
      type: "commandExecution",
      id,
      command: "cat README.md",
      cwd: "/tmp/test",
      status: "completed",
      approvalStatus: null,
      aggregatedOutput: output,
    },
  });
  add("turn/started", {});
  for (let index = 0; index < 100; index++) {
    const id = `command-${index}`;
    add(
      "item/completed",
      command(id, "hidden output\n".repeat(500)),
      id,
      "commandExecution",
    );
  }
  add(
    "item/completed",
    { item: { type: "agentMessage", id: "answer", text: "Done" } },
    "answer",
    "agentMessage",
  );
  add(
    "item/completed",
    command("trailing", "visible output\n".repeat(100)),
    "trailing",
    "commandExecution",
  );
  add("turn/completed", { status: "completed" });
  return { db, thread };
}

function build(
  db: DbConnection,
  thread: Thread,
  includeNestedRows: boolean,
  responseByteBudget = 20_000_000,
) {
  return buildThreadTimelineWithProfile(db, thread, {
    completedTurnDisplay: "collapse",
    includeDiagnosticOperations: false,
    includeNestedRows,
    eventBudget: 1500,
    maxInlineOutputChars: 32_000,
    maxSeq: 0,
    page: { kind: "latest", segmentLimit: 8 },
    responseByteBudget,
  });
}

describe("timeline command output selection", () => {
  it("omits hidden payloads while preserving visible output, summary bounds, and expansion", () => {
    const { db, thread } = fixture();
    try {
      const collapsed = build(db, thread, false);
      const expanded = build(db, thread, true);
      expect(collapsed.response.rows).toEqual(
        expanded.response.rows.map((row) =>
          row.kind === "turn" ? { ...row, children: null } : row,
        ),
      );
      expect(collapsed.profile.eventDataBytes).toBeLessThan(
        expanded.profile.eventDataBytes / 5,
      );
      const summary = expanded.response.rows.find((row) => row.kind === "turn");
      if (summary?.kind !== "turn" || summary.turnId === null)
        throw new Error("Missing summary");
      const details = buildTimelineTurnSummaryDetails(db, thread, {
        turnId: summary.turnId,
        sourceSeqStart: summary.sourceSeqStart,
        sourceSeqEnd: summary.sourceSeqEnd,
        completedTurnDisplay: "collapse",
        includeDiagnosticOperations: false,
      });
      expect(details.rows).toEqual(summary.children);
      const visible = collapsed.response.rows.find(
        (row) => row.kind === "work" && row.workKind === "command",
      );
      expect(visible).toMatchObject({ output: "visible output\n".repeat(100) });
    } finally {
      db.$client.close();
    }
  });

  it("hydrates visible payloads before applying the response byte budget", () => {
    const { db, thread } = fixture();
    try {
      const collapsed = build(db, thread, false, 1000).response;
      const full = build(
        db,
        { ...thread, status: "active" },
        false,
        1000,
      ).response;
      expect(collapsed.rows).toEqual(full.rows);
      expect(collapsed.timelinePage.hasOlderRows).toEqual(
        full.timelinePage.hasOlderRows,
      );
      expect(collapsed.timelinePage.olderCursor?.anchorSeq).toEqual(
        full.timelinePage.olderCursor?.anchorSeq,
      );
      expect(collapsed.timelinePage.contentPage).toEqual(
        full.timelinePage.contentPage,
      );
    } finally {
      db.$client.close();
    }
  });
});
