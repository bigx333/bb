import { describe, expect, it } from "vitest";
import { makeThreadQueuedMessage } from "@bb/test-helpers/domain-fixtures";
import type { Submission } from "@/lib/message-delivery/store";
import { projectQueuedMessageRows } from "./queued-message-rows";

function submission(
  overrides: Partial<Extract<Submission, { kind: "queue" }>> = {},
): Submission {
  return {
    version: 1,
    kind: "queue",
    id: "local-one",
    clientSubmissionId: "submission-one",
    threadId: "thread-one",
    sequence: 1,
    createdAt: 100,
    updatedAt: 100,
    status: "pending",
    attempted: false,
    attempts: 0,
    retryCount: 0,
    retainAcceptanceUntil: null,
    acceptanceObserved: false,
    nextAttemptAt: 0,
    error: null,
    accepted: null,
    reconciled: false,
    handoff: {
      storageKey: "draft-one",
      draft: { text: "Preserve this", mentions: [], attachments: [] },
      handoffId: "submission-one",
      completed: true,
    },
    request: {
      input: [{ type: "text", text: "Preserve this", mentions: [] }],
      clientSubmissionId: "submission-one",
    },
    ...overrides,
  };
}

describe("durable queue projection", () => {
  it("keeps a local row across empty server refetches and replaces it only by submission identity", () => {
    const local = submission();
    const unrelated = makeThreadQueuedMessage({
      id: "server-one",
      content: local.request.input,
    });
    const rows = projectQueuedMessageRows({
      serverMessages: [unrelated],
      submissions: [local],
      connected: false,
    });
    expect(rows.map((row) => row.id)).toEqual(["server-one", "local-one"]);
    expect(
      projectQueuedMessageRows({
        serverMessages: [],
        submissions: [local],
        connected: false,
      }),
    ).toEqual([rows[1]]);

    const accepted = {
      ...unrelated,
      clientSubmissionId: local.clientSubmissionId,
    };
    expect(
      projectQueuedMessageRows({
        serverMessages: [accepted],
        submissions: [local],
        connected: true,
      }),
    ).toEqual([accepted]);
  });

  it("retains distinct identical messages and keeps corrected rows stable while requests use fresh IDs", () => {
    const first = submission();
    const second = submission({
      id: "local-two",
      clientSubmissionId: "submission-two",
    });
    const corrected = submission({
      clientSubmissionId: "submission-corrected",
      sequence: 3,
    });
    const rows = projectQueuedMessageRows({
      serverMessages: [],
      submissions: [corrected, second],
      connected: true,
    });
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(rows[0]).toMatchObject({
      clientSubmissionId: "submission-corrected",
      source: "local",
    });
  });

  it("freezes attempted rows and keeps definitive errors editable through refresh reconciliation", () => {
    const uncertain = submission({ status: "uncertain", attempted: true });
    expect(
      projectQueuedMessageRows({
        serverMessages: [],
        submissions: [uncertain],
        connected: true,
      })[0],
    ).toMatchObject({
      editable: false,
      deliveryStatus: "confirming",
    });
    expect(
      projectQueuedMessageRows({
        serverMessages: [],
        submissions: [
          {
            ...uncertain,
            status: "rejected",
            error: "Attachment no longer exists",
          },
        ],
        connected: true,
      })[0],
    ).toMatchObject({
      editable: true,
      deliveryStatus: "rejected",
      error: "Attachment no longer exists",
    });
    expect(
      projectQueuedMessageRows({
        serverMessages: [],
        submissions: [{ ...uncertain, status: "accepted", reconciled: true }],
        connected: true,
      }),
    ).toEqual([]);
  });
});
