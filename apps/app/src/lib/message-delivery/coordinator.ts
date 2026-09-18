import { nanoid } from "nanoid";
import {
  claimSubmission,
  completeSubmissionHandoff,
  getSubmissionStorageError,
  getSubmissions,
  pruneObservedSubmissions,
  refreshSubmissions,
  renewSubmissionClaim,
  settleSubmission,
  subscribeSubmissions,
  type Submission,
  type SubmissionAcceptance,
  type SubmissionClaim,
} from "./store";

export interface DeliveryFailure {
  kind: "transient" | "rejected" | "unknown";
  message: string;
  resolvesUncertainty?: boolean;
}

export interface MessageDeliveryOptions {
  getAvailability: () => { enabled: boolean; connected: boolean };
  subscribeAvailability: (listener: () => void) => () => void;
  deliver: (
    entry: Submission,
    signal: AbortSignal,
  ) => Promise<SubmissionAcceptance>;
  reconcile: (
    entry: Submission,
    accepted: SubmissionAcceptance,
    signal: AbortSignal,
  ) => Promise<void>;
  classifyFailure: (error: unknown, entry: Submission) => DeliveryFailure;
  onError?: (error: Error) => void;
}

const leaseMs = 45_000;
const requestTimeoutMs = 30_000;
const renewIntervalMs = 10_000;
const maxConcurrentThreads = 2;

function failureError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Message delivery could not be completed.");
}

function retryDelay(entry: Submission): number {
  const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(entry.retryCount, 6));
  return Math.round(backoff * (0.8 + Math.random() * 0.4));
}

export function startMessageDelivery(
  options: MessageDeliveryOptions,
): () => void {
  const owner = nanoid();
  const active = new Set<string>();
  const wakeTimes = new Map<string, number>();
  const controllers = new Set<AbortController>();
  const recovering = new Set<string>();
  let stopped = false;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStorageError: Error | null = null;

  const available = () => {
    const state = options.getAvailability();
    return (
      !stopped && state.enabled && state.connected && navigator.onLine !== false
    );
  };

  function scheduleTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    const future = [...wakeTimes.values()].filter(
      (time) => Number.isFinite(time) && time > Date.now(),
    );
    if (future.length === 0 || stopped) {
      timer = undefined;
      return;
    }
    timer = setTimeout(kick, Math.max(0, Math.min(...future) - Date.now()));
  }

  function kick(): void {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  }

  async function attempt(claim: SubmissionClaim): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    let leaseLost = false;
    let rejectAbort: (error: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(
        controller.signal.reason ??
          new DOMException("Message delivery interrupted", "AbortError"),
      );
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException("Message delivery timed out", "TimeoutError"),
        ),
      requestTimeoutMs,
    );
    const renewal = setInterval(() => {
      void renewSubmissionClaim(claim, Date.now(), leaseMs)
        .then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            controller.abort(
              new DOMException("Message delivery claim expired", "AbortError"),
            );
          }
        })
        .catch((error) => {
          leaseLost = true;
          controller.abort(failureError(error));
        });
    }, renewIntervalMs);
    try {
      const entry = claim.entry;
      if (entry.accepted !== null) {
        await Promise.race([
          options.reconcile(entry, entry.accepted, controller.signal),
          aborted,
        ]);
        if (!leaseLost) await settleSubmission(claim, { kind: "reconciled" });
      } else {
        const accepted = await Promise.race([
          options.deliver(entry, controller.signal),
          aborted,
        ]);
        if (!leaseLost)
          await settleSubmission(claim, { kind: "accepted", accepted });
      }
    } catch (error) {
      if (leaseLost) {
        wakeTimes.set(claim.threadId, Date.now() + leaseMs);
        return;
      }
      const failure = options.classifyFailure(error, claim.entry);
      const definitive =
        claim.entry.accepted === null &&
        failure.kind === "rejected" &&
        (claim.entry.attempts === 1 || failure.resolvesUncertainty === true);
      if (definitive) {
        await settleSubmission(claim, {
          kind: "rejected",
          error: failure.message,
        });
        options.onError?.(failureError(error));
      } else {
        const nextAttemptAt = Date.now() + retryDelay(claim.entry);
        await settleSubmission(claim, {
          kind: "retry",
          error: failure.message,
          nextAttemptAt,
        });
        wakeTimes.set(claim.threadId, nextAttemptAt);
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(renewal);
      controller.signal.removeEventListener("abort", onAbort);
      controllers.delete(controller);
    }
  }

  async function drain(threadId: string): Promise<void> {
    try {
      const result = await claimSubmission(
        threadId,
        owner,
        Date.now(),
        leaseMs,
      );
      if ("claim" in result) {
        if (!available()) {
          await settleSubmission(result.claim, {
            kind: "retry",
            error: "Waiting for connection",
            nextAttemptAt: Date.now() + 1_000,
            unattempted: true,
          });
          wakeTimes.set(threadId, Date.now() + 1_000);
          return;
        }
        await attempt(result.claim);
      } else if (result.wakeAt !== null) wakeTimes.set(threadId, result.wakeAt);
      else wakeTimes.set(threadId, Infinity);
    } catch (error) {
      options.onError?.(failureError(error));
      wakeTimes.set(threadId, Date.now() + 5_000);
    } finally {
      active.delete(threadId);
      await refreshSubmissions();
      kick();
    }
  }

  function pump(): void {
    if (stopped) return;
    const error = getSubmissionStorageError();
    if (error && error !== lastStorageError) options.onError?.(error);
    lastStorageError = error;
    const entries = getSubmissions();
    for (const entry of entries) {
      if (
        !entry.handoff.completed &&
        !recovering.has(entry.id) &&
        (wakeTimes.get(`handoff:${entry.id}`) ?? 0) <= Date.now()
      ) {
        recovering.add(entry.id);
        void completeSubmissionHandoff(entry)
          .catch((failure) => {
            options.onError?.(failureError(failure));
            wakeTimes.set(`handoff:${entry.id}`, Date.now() + 5_000);
          })
          .finally(() => {
            recovering.delete(entry.id);
            scheduleTimer();
          });
      }
    }
    if (!available() || error) {
      scheduleTimer();
      return;
    }
    const threads = new Set(
      entries
        .filter(
          (entry) =>
            entry.status !== "rejected" &&
            !(entry.status === "accepted" && entry.reconciled),
        )
        .map((entry) => entry.threadId),
    );
    for (const threadId of threads) {
      if (active.size >= maxConcurrentThreads) break;
      if (active.has(threadId) || (wakeTimes.get(threadId) ?? 0) > Date.now())
        continue;
      active.add(threadId);
      void drain(threadId);
    }
    scheduleTimer();
  }

  function wake(): void {
    wakeTimes.clear();
    if (!available())
      for (const controller of controllers)
        controller.abort(
          new DOMException("Connection unavailable", "AbortError"),
        );
    void refreshSubmissions().then(kick);
  }

  const unsubscribeStore = subscribeSubmissions(() => {
    for (const key of wakeTimes.keys())
      if (!key.startsWith("handoff:")) wakeTimes.delete(key);
    kick();
  });
  const unsubscribeAvailability = options.subscribeAvailability(wake);
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  void pruneObservedSubmissions().catch((error) =>
    options.onError?.(failureError(error)),
  );
  wake();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribeStore();
    unsubscribeAvailability();
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
    window.removeEventListener("offline", wake);
    for (const controller of controllers)
      controller.abort(
        new DOMException("Message delivery paused", "AbortError"),
      );
  };
}
