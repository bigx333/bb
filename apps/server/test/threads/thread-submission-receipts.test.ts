import { queueInputForStartingTurn } from "../../src/services/threads/thread-turn-starting.js";
import { buildExecutionOptions } from "../../src/services/threads/thread-commands.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../../src/errors.js";
import { withThreadSubmissionReceipt } from "../../src/services/threads/thread-submission-receipts.js";
import {
  archiveThread,
  createConnection,
  deleteQueuedThreadMessage,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  threadSubmissionReceipts,
} from "@bb/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  defaultFeatureFlags,
  featureFlagsSchema,
  threadScope,
} from "@bb/domain";
import { sendMessageResponseSchema } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { createQueuedMessageForThread } from "../../src/services/threads/queued-messages.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedEvent,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function fixture(
  harness: TestAppHarness,
  status: "idle" | "active" | "error" = "idle",
) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/submission-receipts",
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-submission",
    threadId: thread.id,
  });
  return { thread, environment };
}

function requestCount(harness: Pick<TestAppHarness, "db">, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  ).length;
}

afterEach(() => vi.restoreAllMocks());

describe("durable submission acceptance", () => {
  const clientSubmissionId = "message_nanoid-123";

  it("coalesces concurrent sends and replays the original turn after reopen and archive", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness);
      const before = requestCount(harness, thread.id);
      const payload = {
        clientSubmissionId,
        input: textInput("send once"),
        mode: "start" as const,
      };
      const [first, duplicate] = await Promise.all([
        acceptThreadSendRequest(harness.deps, { thread, payload }),
        acceptThreadSendRequest(harness.deps, { thread, payload }),
      ]);
      expect(first).toMatchObject({
        ok: true,
        delivery: "sent",
        clientSubmissionId,
        turnRequestId: expect.any(String),
      });
      expect(duplicate).toEqual({ ...first, replayed: true });
      expect(requestCount(harness, thread.id)).toBe(before + 1);
      archiveThread(harness.db, harness.hub, thread.id);
      const reopened = createConnection(harness.db.$client.serialize());
      try {
        const archived = getThread(reopened, thread.id);
        if (!archived) throw new Error("Expected archived thread");
        await expect(
          acceptThreadSendRequest(
            { ...harness.deps, db: reopened },
            { thread: archived, payload },
          ),
        ).resolves.toEqual({ ...first, replayed: true });
        expect(requestCount({ db: reopened }, thread.id)).toBe(before + 1);
      } finally {
        reopened.$client.close();
      }
    });
  });

  it("keeps compatible queue replay metadata after consumption without storing the content twice", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness, "active");
      const payload = {
        clientSubmissionId,
        input: textInput("queue once"),
        serviceTier: "default" as const,
      };
      const [first, duplicate] = await Promise.all([
        createQueuedMessageForThread(harness.deps, { thread, payload }),
        createQueuedMessageForThread(harness.deps, { thread, payload }),
      ]);
      expect(first.clientSubmissionId).toBe(clientSubmissionId);
      expect(duplicate).toEqual({ ...first, replayed: true });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      const receipt = harness.db.select().from(threadSubmissionReceipts).get();
      expect(receipt?.result).not.toContain("queue once");
      deleteQueuedThreadMessage(harness.db, harness.hub, first.id);
      const reopened = createConnection(harness.db.$client.serialize());
      try {
        const replay = await createQueuedMessageForThread(
          { ...harness.deps, db: reopened },
          { thread, payload },
        );
        expect(replay).toEqual({ ...first, replayed: true });
        expect(
          sendMessageResponseSchema.parse({
            ok: true,
            delivery: "queued",
            clientSubmissionId,
            replayed: true,
            queuedMessage: replay,
          }),
        ).toMatchObject({
          queuedMessage: {
            content: payload.input,
            model: first.model,
            createdAt: first.createdAt,
          },
        });
        expect(listQueuedThreadMessages(reopened, thread.id)).toHaveLength(0);
      } finally {
        reopened.$client.close();
      }
    });
  });

  it("uses database uniqueness when concurrent attempts have different connections", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness, "active");
      const path = join(
        harness.config.dataDir,
        "submission-concurrency.sqlite",
      );
      writeFileSync(path, harness.db.$client.serialize());
      const firstDb = createConnection(path);
      const secondDb = createConnection(path);
      const payload = {
        clientSubmissionId,
        input: textInput("one database admission"),
      };
      try {
        const results = await Promise.all([
          createQueuedMessageForThread(
            { ...harness.deps, db: firstDb },
            { thread, payload },
          ),
          createQueuedMessageForThread(
            { ...harness.deps, db: secondDb },
            { thread, payload },
          ),
        ]);
        expect(results[0]?.id).toBe(results[1]?.id);
        expect(listQueuedThreadMessages(firstDb, thread.id)).toHaveLength(1);
        expect(
          firstDb.select().from(threadSubmissionReceipts).all(),
        ).toHaveLength(1);
      } finally {
        firstDb.$client.close();
        secondDb.$client.close();
      }
    });
  });

  it("marks only a settled unaccepted API failure while preserving its details", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness);
      const error = new ApiError(400, "invalid_request", "Bad content", {
        details: { field: "input" },
      });
      await expect(
        withThreadSubmissionReceipt(
          harness.db,
          {
            threadId: thread.id,
            operation: "send",
            payload: {
              clientSubmissionId,
              input: textInput("rejected"),
              mode: "start",
            },
          },
          async () => {
            throw error;
          },
        ),
      ).rejects.toMatchObject({
        status: 400,
        body: {
          code: "invalid_request",
          details: {
            field: "input",
            submission: { clientSubmissionId, acceptance: "rejected" },
          },
        },
      });
      expect(
        harness.db.select().from(threadSubmissionReceipts).all(),
      ).toHaveLength(0);
    });
  });

  it("records turn-starting queue acceptance in the same transaction", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness, "active");
      const payload = {
        clientSubmissionId,
        input: textInput("wait for startup"),
        mode: "queue-if-active" as const,
      };
      const execution = await buildExecutionOptions(
        harness.deps,
        {},
        { threadId: thread.id },
      );
      const submit = () =>
        withThreadSubmissionReceipt(
          harness.db,
          { threadId: thread.id, operation: "send", payload },
          async (submission) => {
            const outcome = queueInputForStartingTurn(harness.deps, {
              claimed: null,
              threadId: thread.id,
              input: {
                submission,
                input: payload.input,
                execution,
                senderThreadId: null,
                origin: null,
                originPluginId: null,
                requestedBy: null,
                payload: { kind: "inline" },
                systemNotice: null,
              },
            });
            if (outcome.kind !== "queued")
              throw new Error("Expected starting queue");
            return {
              ok: true,
              delivery: "queued",
              queuedMessage: outcome.entry,
            };
          },
        );
      const first = await submit();
      expect(first).toMatchObject({
        delivery: "queued",
        queuedMessage: {
          waitingOn: { kind: "turn-starting" },
          clientSubmissionId,
        },
      });
      expect(await submit()).toMatchObject({ replayed: true });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    });
  });

  it("rejects changed payloads both during an attempt and after acceptance", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness, "active");
      const payload = { clientSubmissionId, input: textInput("immutable") };
      const pending = createQueuedMessageForThread(harness.deps, {
        thread,
        payload,
      });
      const changed = () =>
        createQueuedMessageForThread(harness.deps, {
          thread,
          payload: { ...payload, input: textInput("changed") },
        });
      await expect(changed()).rejects.toMatchObject({
        status: 409,
        body: { code: "client_submission_conflict" },
      });
      await pending;
      await expect(changed()).rejects.toMatchObject({
        status: 409,
        body: { code: "client_submission_conflict" },
      });
      await expect(
        acceptThreadSendRequest(harness.deps, {
          thread,
          payload: { ...payload, mode: "start" },
        }),
      ).rejects.toMatchObject({
        status: 409,
        body: { code: "client_submission_conflict" },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    });
  });

  it.each(["send", "queue"] as const)(
    "rolls back the %s receipt together with a failed admission",
    async (operation) => {
      await withTestHarness(async (harness) => {
        const { thread } = fixture(
          harness,
          operation === "queue" ? "active" : "idle",
        );
        const before = requestCount(harness, thread.id);
        const payload = {
          clientSubmissionId,
          input: textInput("retry after rollback"),
        };
        const submit = () =>
          operation === "send"
            ? acceptThreadSendRequest(harness.deps, {
                thread,
                payload: { ...payload, mode: "start" },
              })
            : createQueuedMessageForThread(harness.deps, { thread, payload });
        const table =
          operation === "send" ? "events" : "queued_thread_messages";
        harness.db.$client.exec(
          `CREATE TRIGGER reject_submission BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'admission failed'); END`,
        );
        await expect(submit()).rejects.toMatchObject(
          operation === "send"
            ? { cause: { message: "admission failed" } }
            : { message: "admission failed" },
        );
        expect(
          harness.db.select().from(threadSubmissionReceipts).all(),
        ).toHaveLength(0);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
        expect(requestCount(harness, thread.id)).toBe(before);
        harness.db.$client.exec("DROP TRIGGER reject_submission");
        await submit();
        expect(
          harness.db.select().from(threadSubmissionReceipts).all(),
        ).toHaveLength(1);
      });
    },
  );

  it("returns committed acceptance when notification throws after commit", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness, "active");
      const payload = {
        clientSubmissionId,
        input: textInput("accepted before disconnect"),
      };
      vi.spyOn(harness.hub, "notifyThread").mockImplementationOnce(() => {
        throw new Error("connection closed");
      });
      const accepted = await createQueuedMessageForThread(harness.deps, {
        thread,
        payload,
      });
      expect(accepted).toMatchObject({ clientSubmissionId, replayed: true });
      await expect(
        createQueuedMessageForThread(harness.deps, { thread, payload }),
      ).resolves.toEqual(accepted);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    });
  });

  it("queues an ordinary idle send that reaches an active thread instead of steering", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness, "active");
      const before = requestCount(harness, thread.id);
      const payload = {
        clientSubmissionId,
        input: textInput("ordinary follow-up"),
        mode: "start" as const,
      };
      const first = await acceptThreadSendRequest(harness.deps, {
        thread,
        payload,
      });
      expect(first).toMatchObject({
        delivery: "queued",
        clientSubmissionId,
        queuedMessage: {
          clientSubmissionId,
          waitingOn: { kind: "thread-busy" },
        },
      });
      await acceptThreadSendRequest(harness.deps, { thread, payload });
      expect(requestCount(harness, thread.id)).toBe(before);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    });
  });

  it.each(["idle", "error"] as const)(
    "wakes an accepted queued follow-up on an %s thread",
    async (status) => {
      await withTestHarness(async (harness) => {
        const { thread } = fixture(harness, status);
        const before = requestCount(harness, thread.id);
        await createQueuedMessageForThread(harness.deps, {
          thread,
          payload: {
            clientSubmissionId,
            input: textInput("wake this follow-up"),
          },
        });
        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });
        expect(requestCount(harness, thread.id)).toBe(before + 1);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      });
    },
  );

  it("wakes a queued submission on a never-started existing thread", async () => {
    await withTestHarness(async (harness) => {
      const { thread: existing, environment } = fixture(harness);
      const created = await createThreadFromRequest(harness.deps, {
        projectId: existing.projectId,
        providerId: existing.providerId,
        origin: "app",
        input: textInput("scheduled original"),
        sendAt: Date.now() + 60_000,
        startedOnBehalfOf: null,
        environment: {
          type: "host",
          hostId: environment.hostId,
          workspace: { type: "unmanaged", path: "/tmp/submission-receipts" },
        },
      });
      const thread = getThread(harness.db, created.id);
      if (!thread) throw new Error("Expected pending thread");
      expect(thread.status).toBe("pending");
      const queued = await createQueuedMessageForThread(harness.deps, {
        thread,
        payload: {
          clientSubmissionId,
          input: textInput("ready before scheduled original"),
        },
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      expect(getThread(harness.db, thread.id)?.status).not.toBe("pending");
      expect(
        listQueuedThreadMessages(harness.db, thread.id).some(
          (row) => row.id === queued.id,
        ),
      ).toBe(false);
      expect(requestCount(harness, thread.id)).toBe(1);
    });
  });

  it("preserves manual queue pause and rejects conversation commands before admission", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = fixture(harness);
      const before = requestCount(harness, thread.id);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 3,
        type: "system/thread/interrupted",
        scope: threadScope(),
        data: { reason: "manual-stop" },
      });
      await createQueuedMessageForThread(harness.deps, {
        thread,
        payload: { clientSubmissionId, input: textInput("wait for resume") },
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      expect(requestCount(harness, thread.id)).toBe(before);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      await expect(
        acceptThreadSendRequest(harness.deps, {
          thread,
          payload: {
            clientSubmissionId: "command",
            mode: "start",
            input: createStandaloneBuiltinCompactCommandInput(),
          },
        }),
      ).rejects.toMatchObject({
        status: 400,
        body: { code: "client_submission_unsupported" },
      });
    });
  });

  it("does not infer durable support from older feature flags", () => {
    expect(
      featureFlagsSchema.parse(defaultFeatureFlags).durableMessageDelivery,
    ).toBeUndefined();
  });

  it("retains legacy calls and keeps identical deliberate submissions distinct", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness, "active");
      const input = textInput("same text");
      await createQueuedMessageForThread(harness.deps, {
        thread,
        payload: { input },
      });
      await createQueuedMessageForThread(harness.deps, {
        thread,
        payload: { input },
      });
      await createQueuedMessageForThread(harness.deps, {
        thread,
        payload: { input, clientSubmissionId: "first" },
      });
      await createQueuedMessageForThread(harness.deps, {
        thread,
        payload: { input, clientSubmissionId: "second" },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(4);
      expect(
        harness.db.select().from(threadSubmissionReceipts).all(),
      ).toHaveLength(2);
      await expect(
        acceptThreadSendRequest(harness.deps, {
          thread,
          payload: {
            input,
            clientSubmissionId: "steer",
            mode: "steer-if-active",
          },
        }),
      ).rejects.toMatchObject({
        status: 400,
        body: { code: "client_submission_unsupported" },
      });
    });
  });
});
