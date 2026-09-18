import { createHash } from "node:crypto";
import {
  threadSubmissionReceipts,
  type DbConnection,
  type DbTransaction,
} from "@bb/db";
import {
  clientTurnRequestIdSchema,
  jsonValueSchema,
  threadQueuedMessageSchema,
  type JsonValue,
  type PromptInput,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  SendMessageRequest,
  SendMessageResponse,
} from "@bb/server-contract";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../../errors.js";

const acceptedSubmissionSchema = z.discriminatedUnion("delivery", [
  z.object({
    delivery: z.literal("sent"),
    turnRequestId: clientTurnRequestIdSchema,
  }),
  z.object({
    delivery: z.literal("queued"),
    queuedMessage: threadQueuedMessageSchema.omit({
      content: true,
      replayed: true,
    }),
  }),
]);

type AcceptedSubmission = z.infer<typeof acceptedSubmissionSchema>;

export interface ThreadSubmissionReceipt {
  id: string;
  accept<T>(
    tx: DbTransaction,
    admit: () => T,
    result: (value: T) => AcceptedSubmission,
  ): T;
}

interface PendingSubmission {
  fingerprint: string;
  promise: Promise<SendMessageResponse>;
}

const pendingSubmissions = new WeakMap<
  DbConnection,
  Map<string, PendingSubmission>
>();

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function submissionConflict(): ApiError {
  return new ApiError(
    409,
    "client_submission_conflict",
    "This submission ID was already used for a different message",
  );
}

export function requireOrdinarySubmission(
  input: PromptInput[],
  mode?: SendMessageRequest["mode"],
): void {
  if (
    (mode !== undefined && mode !== "start" && mode !== "queue-if-active") ||
    input.some(
      (block) =>
        block.type === "text" &&
        block.mentions.some(
          (mention) =>
            mention.resource.kind === "command" &&
            mention.resource.source === "command",
        ),
    )
  ) {
    throw new ApiError(
      400,
      "client_submission_unsupported",
      "Durable delivery is only available for ordinary messages and queued follow-ups",
    );
  }
}

export function acceptThreadSubmission<T>(
  tx: DbTransaction,
  receipt: ThreadSubmissionReceipt | undefined,
  admit: () => T,
  result: (value: T) => AcceptedSubmission,
): T {
  return receipt === undefined ? admit() : receipt.accept(tx, admit, result);
}

function markReplayed(response: SendMessageResponse): SendMessageResponse {
  return response.delivery === "sent"
    ? { ...response, replayed: true }
    : {
        ...response,
        replayed: true,
        queuedMessage: { ...response.queuedMessage, replayed: true },
      };
}

export async function withThreadSubmissionReceipt(
  db: DbConnection,
  args: {
    threadId: string;
    operation: "send" | "queue";
    payload: SendMessageRequest | CreateQueuedMessageRequest;
  },
  submit: (
    receipt: ThreadSubmissionReceipt | undefined,
  ) => Promise<SendMessageResponse>,
): Promise<SendMessageResponse> {
  const clientSubmissionId = args.payload.clientSubmissionId;
  if (clientSubmissionId === undefined) return submit(undefined);
  const requestJson = JSON.stringify(args.payload);
  const fingerprint = createHash("sha256")
    .update(canonicalJson(jsonValueSchema.parse(JSON.parse(requestJson))))
    .digest("hex");
  const where = and(
    eq(threadSubmissionReceipts.threadId, args.threadId),
    eq(threadSubmissionReceipts.clientSubmissionId, clientSubmissionId),
  );
  const readAccepted = (): SendMessageResponse | null => {
    const row = db.select().from(threadSubmissionReceipts).where(where).get();
    if (row === undefined) return null;
    if (row.fingerprint !== fingerprint || row.operation !== args.operation)
      throw submissionConflict();
    if (row.result === null)
      throw new ApiError(
        500,
        "internal_error",
        "Submission receipt was not completed",
      );
    const result = acceptedSubmissionSchema.parse(JSON.parse(row.result));
    if (result.delivery === "sent")
      return {
        ok: true,
        delivery: "sent",
        turnRequestId: result.turnRequestId,
        clientSubmissionId,
      };
    return {
      ok: true,
      delivery: "queued",
      clientSubmissionId,
      queuedMessage: {
        ...result.queuedMessage,
        content: args.payload.input,
        clientSubmissionId,
      },
    };
  };
  const accepted = readAccepted();
  if (accepted !== null) return markReplayed(accepted);
  const pending =
    pendingSubmissions.get(db) ?? new Map<string, PendingSubmission>();
  pendingSubmissions.set(db, pending);
  const key = JSON.stringify([args.threadId, clientSubmissionId]);
  const operationFingerprint = `${args.operation}:${fingerprint}`;
  const existing = pending.get(key);
  if (existing !== undefined) {
    if (existing.fingerprint !== operationFingerprint)
      throw submissionConflict();
    return existing.promise.then(markReplayed);
  }
  const receipt: ThreadSubmissionReceipt = {
    id: clientSubmissionId,
    accept(tx, admit, result) {
      const inserted = tx
        .insert(threadSubmissionReceipts)
        .values({
          threadId: args.threadId,
          clientSubmissionId,
          operation: args.operation,
          fingerprint,
          result: null,
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .returning()
        .get();
      if (inserted === undefined)
        throw new ApiError(
          409,
          "client_submission_in_progress",
          "Submission is already being accepted",
        );
      const value = admit();
      const acceptance = acceptedSubmissionSchema.parse(result(value));
      tx.update(threadSubmissionReceipts)
        .set({ result: JSON.stringify(acceptance) })
        .where(where)
        .run();
      return value;
    },
  };
  const promise = Promise.resolve().then(async () => {
    try {
      await submit(receipt);
      const acceptance = readAccepted();
      if (acceptance === null)
        throw new ApiError(
          500,
          "internal_error",
          "Message was not durably accepted",
        );
      return acceptance;
    } catch (error) {
      const acceptance = readAccepted();
      if (acceptance !== null) return markReplayed(acceptance);
      if (error instanceof ApiError) {
        const details = error.body.details;
        if (
          details === undefined ||
          (details !== null &&
            typeof details === "object" &&
            !Array.isArray(details))
        ) {
          error.body.details = {
            ...details,
            submission: { clientSubmissionId, acceptance: "rejected" },
          };
        }
      }
      throw error;
    } finally {
      pending.delete(key);
    }
  });
  pending.set(key, { fingerprint: operationFingerprint, promise });
  return promise;
}
