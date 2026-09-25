import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket as NodeWebSocket } from "ws";
import { HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE } from "@bb/tunnel-contract";
import { TunnelSession } from "../src/session.js";

class FakeTunnel extends EventEmitter {
  readonly readyState = 1;
  readonly sent: unknown[] = [];
  readonly terminate = vi.fn();

  send(data: unknown): void {
    this.sent.push(data);
  }

  heartbeatsSent(): number {
    return this.sent.filter((data) => data === HEARTBEAT_REQUEST).length;
  }

  answerHeartbeat(): void {
    this.emit("message", Buffer.from(HEARTBEAT_RESPONSE), false);
  }
}

function startSession() {
  const tunnel = new FakeTunnel();
  const warnings: string[] = [];
  const session = new TunnelSession({
    tunnel: tunnel as unknown as NodeWebSocket,
    log: { warn: (message) => warnings.push(message) },
    resolveOrigin: () => ({ kind: "unregistered" }),
  });
  session.start();
  return { tunnel, session, warnings };
}

function stallEventLoop(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe("tunnel heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a tunnel whose heartbeats are answered", () => {
    const { tunnel, session } = startSession();
    for (let tick = 0; tick < 10; tick += 1) {
      vi.advanceTimersByTime(20_000);
      tunnel.answerHeartbeat();
    }
    expect(tunnel.terminate).not.toHaveBeenCalled();
    session.dispose();
  });

  it("terminates a tunnel whose heartbeats go unanswered for a minute", () => {
    const { tunnel, session, warnings } = startSession();
    vi.advanceTimersByTime(80_000);
    expect(tunnel.terminate).toHaveBeenCalledTimes(1);
    expect(warnings).toContain("tunnel heartbeat missed; reconnecting");
    session.dispose();
  });

  it("does not terminate a healthy tunnel after the event loop stalls past the deadline", () => {
    const { tunnel, session, warnings } = startSession();
    vi.advanceTimersByTime(20_000);
    tunnel.answerHeartbeat();

    stallEventLoop(90_000);
    vi.advanceTimersByTime(20_000);

    expect(tunnel.terminate).not.toHaveBeenCalled();
    expect(tunnel.heartbeatsSent()).toBe(2);
    expect(warnings.some((message) => message.includes("stalled"))).toBe(true);
    tunnel.answerHeartbeat();
    vi.advanceTimersByTime(40_000);
    expect(tunnel.terminate).not.toHaveBeenCalled();
    session.dispose();
  });

  it("still terminates a dead tunnel once the deadline after a stall passes", () => {
    const { tunnel, session } = startSession();
    stallEventLoop(90_000);
    vi.advanceTimersByTime(20_000);
    expect(tunnel.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80_000);
    expect(tunnel.terminate).toHaveBeenCalledTimes(1);
    session.dispose();
  });
});
