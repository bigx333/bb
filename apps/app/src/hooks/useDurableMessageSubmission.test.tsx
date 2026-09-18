// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPromptDraftState } from "@bb/client-core";
import { useDurableMessageSubmission } from "./useDurableMessageSubmission";

const mocks = vi.hoisted(() => ({
  enabled: true,
  connected: true,
  enqueue: vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: { featureFlags: { durableMessageDelivery: mocks.enabled } },
  }),
}));
vi.mock("@/hooks/useServerConnectionState", () => ({
  useServerConnectionState: () =>
    mocks.connected ? "connected" : "disconnected",
}));
vi.mock("@/lib/message-delivery/store", () => ({
  enqueueSubmission: mocks.enqueue,
}));

const input = [
  { type: "text" as const, text: "Keep this message", mentions: [] },
];
const draft = { storageKey: "draft-thread-1", value: emptyPromptDraftState() };

describe("durable composer submission", () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.connected = true;
    mocks.enqueue.mockReset();
  });
  afterEach(cleanup);

  it("unlocks after local save while programmatic acceptance is still pending", async () => {
    let accept = () => {};
    const acceptance = new Promise<void>((resolve) => {
      accept = resolve;
    });
    mocks.enqueue.mockResolvedValue({ acceptance });
    const { result } = renderHook(() =>
      useDurableMessageSubmission("thread-1"),
    );
    await act(async () => {
      const saved = await result.current.enqueue(
        { kind: "send", request: { input, mode: "queue-if-active" } },
        draft,
        true,
      );
      expect(saved.acceptance).toBe(acceptance);
    });
    expect(result.current.isSaving).toBe(false);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        draft,
        awaitAcceptance: true,
      }),
    );
    accept();
    await acceptance;
  });

  it("retains the composer after local persistence fails and permits another attempt", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("Storage is full"));
    mocks.enqueue.mockResolvedValueOnce({});
    const { result } = renderHook(() =>
      useDurableMessageSubmission("thread-1"),
    );
    await act(async () => {
      await expect(
        result.current.enqueue({ kind: "queue", request: { input } }, draft),
      ).rejects.toThrow("Storage is full");
    });
    expect(result.current.isSaving).toBe(false);
    await act(async () => {
      await result.current.enqueue(
        { kind: "queue", request: { input } },
        draft,
      );
    });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });

  it("does not persist steering or runtime commands", async () => {
    const { result } = renderHook(() =>
      useDurableMessageSubmission("thread-1"),
    );
    await act(async () => {
      await expect(
        result.current.enqueue(
          { kind: "send", request: { input, mode: "steer" } },
          draft,
        ),
      ).rejects.toThrow("Steering requires");
      await expect(
        result.current.enqueue(
          {
            kind: "queue",
            request: {
              input: [{ type: "text", text: "/clear", mentions: [] }],
            },
          },
          draft,
        ),
      ).rejects.toThrow("does not support offline delivery");
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
