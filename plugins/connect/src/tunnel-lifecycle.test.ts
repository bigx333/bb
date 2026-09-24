import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ShareHostResolver } from "./hosts.js";
import { ShareRegistry } from "./shares.js";
import { TEST_ACCOUNT } from "./testing/fake-account.js";

interface FakeWebSocketOptions {
  handshakeTimeout?: number;
  headers?: Record<string, string>;
}

interface FakeTunnelSocket {
  readyState: number;
  emit(eventName: string, ...args: unknown[]): boolean;
  terminate(): void;
}

const fakeWebSockets = vi.hoisted(() => ({
  instances: [] as FakeTunnelSocket[],
  urls: [] as string[],
  options: [] as FakeWebSocketOptions[],
}));

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    readyState = 0;

    constructor(url: string, options: FakeWebSocketOptions) {
      super();
      fakeWebSockets.instances.push(this);
      fakeWebSockets.urls.push(url);
      fakeWebSockets.options.push(options);
    }

    terminate(): void {
      this.readyState = 3;
    }
  }

  return { ...actual, WebSocket: FakeWebSocket };
});

import { ConnectTunnel } from "./tunnel.js";
import type { SharedCredential } from "./account-client.js";
import { DEFAULT_CONNECT_BASE_URL } from "./base-url.js";

const SERVER_CREDENTIAL: SharedCredential = {
  baseUrl: TEST_ACCOUNT.baseUrl,
  serverUrl: TEST_ACCOUNT.serverUrl,
  serverId: TEST_ACCOUNT.serverId,
  credential: "bbcred_server",
};

function createTunnelFixture(
  readCredential: () => Promise<SharedCredential | null> = async () =>
    SERVER_CREDENTIAL,
) {
  const fakeHost = createFakePluginHost({
    pluginId: "connect",
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "host-server" }) as never,
      },
    },
  });
  const pluginBb = fakeHost.bb;
  const read = vi.fn(readCredential);
  const confirmRefused = vi.fn(async (_credential: string) => undefined);
  const onStatusChange = vi.fn();
  const shares = new ShareRegistry({
    kv: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    },
    hosts: pluginBb.hosts,
    hostResolver: new ShareHostResolver(() => pluginBb.sdk),
    getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
    getIdentity: () => tunnel.getIdentity(),
    log: pluginBb.log,
  });
  const tunnel: ConnectTunnel = new ConnectTunnel({
    shares,
    readCredential: read,
    confirmRefusedCredential: confirmRefused,
    defaultBaseUrl: DEFAULT_CONNECT_BASE_URL,
    enabled: true,
    getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
    log: pluginBb.log,
    onStatusChange,
  });
  tunnel.setAccount(TEST_ACCOUNT);
  return { fakeHost, read, confirmRefused, onStatusChange, tunnel };
}

async function socketCount(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(fakeWebSockets.instances).toHaveLength(count);
  });
}

describe("ConnectTunnel socket lifecycle", () => {
  afterEach(() => {
    fakeWebSockets.instances.length = 0;
    fakeWebSockets.urls.length = 0;
    fakeWebSockets.options.length = 0;
  });

  it("dials the account's tunnel URL with the server credential from bb account", async () => {
    const { fakeHost, read, tunnel } = createTunnelFixture();
    try {
      await tunnel.start();
      await socketCount(1);
      expect(read).toHaveBeenCalledTimes(1);
      expect(fakeWebSockets.options[0]?.headers).toEqual({
        authorization: "Bearer bbcred_server",
      });
      const url = new URL(fakeWebSockets.urls[0]!);
      expect(`${url.origin}${url.pathname}`).toBe(
        "wss://sawyer.getbb.app/__tunnel",
      );
      expect(url.searchParams.get("v")).toBe("1");
      expect(url.searchParams.size).toBe(1);
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  it("ignores events from a socket after the tunnel stops", async () => {
    const { fakeHost, onStatusChange, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      await socketCount(1);

      tunnel.stop();
      onStatusChange.mockClear();
      const socket = fakeWebSockets.instances[0]!;
      socket.emit("open");
      socket.emit("unexpected-response", {}, { statusCode: 401, resume() {} });
      socket.emit("error", new Error("late socket error"));
      socket.emit("close", 1006, Buffer.from("late close"));

      expect(onStatusChange).not.toHaveBeenCalled();
      expect(tunnel.getIdentity()?.handle).toBe("sawyer");
      expect(tunnel.status().lastError).toBeNull();
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  it("does not let a replaced socket close the current session", async () => {
    const { fakeHost, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      await socketCount(1);
      const replacedSocket = fakeWebSockets.instances[0]!;

      tunnel.stop();
      await tunnel.start();
      await socketCount(2);
      const currentSocket = fakeWebSockets.instances[1]!;
      currentSocket.emit("open");
      expect(tunnel.status().state).toBe("connected");

      replacedSocket.emit("close", 1006, Buffer.from("late close"));

      expect(tunnel.status().state).toBe("connected");
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  it("sets a bounded opening handshake timeout", async () => {
    const { fakeHost, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      await socketCount(1);

      expect(fakeWebSockets.options[0]?.handshakeTimeout).toEqual(
        expect.any(Number),
      );
      expect(fakeWebSockets.options[0]!.handshakeTimeout).toBeGreaterThan(0);
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  it("retries a stalled handshake and reads the credential again", async () => {
    vi.useFakeTimers();
    const { fakeHost, read, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      await vi.advanceTimersByTimeAsync(0);
      const socket = fakeWebSockets.instances[0]!;
      const terminate = vi.spyOn(socket, "terminate");

      await vi.advanceTimersByTimeAsync(15_000);

      expect(terminate).toHaveBeenCalledOnce();
      expect(tunnel.status().lastError).toContain("handshake timed out");
      const nextRetryAt = tunnel.status().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();

      await vi.advanceTimersByTimeAsync(nextRetryAt! - Date.now());
      expect(fakeWebSockets.instances).toHaveLength(2);
      expect(read).toHaveBeenCalledTimes(2);
      expect(fakeWebSockets.options[1]?.headers).toEqual({
        authorization: "Bearer bbcred_server",
      });
    } finally {
      tunnel.stop();
      vi.useRealTimers();
      await fakeHost.harness.dispose();
    }
  });

  it("retries an HTTP rejection without waiting for close", async () => {
    vi.useFakeTimers();
    const { fakeHost, confirmRefused, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      await vi.advanceTimersByTimeAsync(0);
      const socket = fakeWebSockets.instances[0]!;
      const response = { statusCode: 500, resume: vi.fn() };

      socket.emit("unexpected-response", {}, response);

      expect(response.resume).toHaveBeenCalledOnce();
      expect(tunnel.status().lastError).toBe("tunnel rejected: HTTP 500");
      expect(confirmRefused).not.toHaveBeenCalled();
      const nextRetryAt = tunnel.status().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();

      await vi.advanceTimersByTimeAsync(nextRetryAt! - Date.now());

      expect(fakeWebSockets.instances).toHaveLength(2);
      expect(tunnel.status().nextRetryAt).toBeNull();
    } finally {
      tunnel.stop();
      vi.useRealTimers();
      await fakeHost.harness.dispose();
    }
  });

  it("asks bb account to check a refused credential and backs off instead of dialing in a loop", async () => {
    vi.useFakeTimers();
    const { fakeHost, confirmRefused, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      await vi.advanceTimersByTimeAsync(0);
      fakeWebSockets.instances[0]!.emit(
        "unexpected-response",
        {},
        { statusCode: 401, resume: vi.fn() },
      );
      expect(tunnel.status()).toMatchObject({
        state: "reconnecting",
        lastError: "the gate refused this bb's server credential (HTTP 401)",
      });
      expect(confirmRefused).toHaveBeenCalledExactlyOnceWith("bbcred_server");
      const firstDelay = tunnel.status().nextRetryAt! - Date.now();
      await vi.advanceTimersByTimeAsync(firstDelay);
      fakeWebSockets.instances[1]!.emit(
        "unexpected-response",
        {},
        { statusCode: 401, resume: vi.fn() },
      );
      expect(tunnel.status().nextRetryAt! - Date.now()).toBeGreaterThan(
        firstDelay,
      );
      expect(confirmRefused).toHaveBeenCalledTimes(2);
    } finally {
      tunnel.stop();
      vi.useRealTimers();
      await fakeHost.harness.dispose();
    }
  });

  it("schedules one retry when rejection is followed by close", async () => {
    vi.useFakeTimers();
    const { fakeHost, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      await vi.advanceTimersByTimeAsync(0);
      const socket = fakeWebSockets.instances[0]!;
      socket.emit(
        "unexpected-response",
        {},
        {
          statusCode: 500,
          resume: vi.fn(),
        },
      );
      const nextRetryAt = tunnel.status().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();

      socket.emit("close", 1006, Buffer.from("late close"));

      expect(tunnel.status().nextRetryAt).toBe(nextRetryAt);
      await vi.advanceTimersByTimeAsync(nextRetryAt! - Date.now());
      expect(fakeWebSockets.instances).toHaveLength(2);
    } finally {
      tunnel.stop();
      vi.useRealTimers();
      await fakeHost.harness.dispose();
    }
  });

  it("waits without retrying while the account is signed out", async () => {
    vi.useFakeTimers();
    const { fakeHost, read, tunnel } = createTunnelFixture(async () => null);

    try {
      await tunnel.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(fakeWebSockets.instances).toHaveLength(0);
      expect(tunnel.status()).toMatchObject({
        state: "reconnecting",
        nextRetryAt: null,
        lastError: expect.stringContaining("isn't signed in"),
      });
    } finally {
      tunnel.stop();
      vi.useRealTimers();
      await fakeHost.harness.dispose();
    }
  });

  it("backs off while bb account can't hand over the credential, then dials", async () => {
    vi.useFakeTimers();
    let failures = 1;
    const { fakeHost, read, tunnel } = createTunnelFixture(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("bb account isn't running (HTTP 503)");
      }
      return SERVER_CREDENTIAL;
    });

    try {
      await tunnel.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeWebSockets.instances).toHaveLength(0);
      expect(tunnel.status().lastError).toContain(
        "can't read this bb's server credential",
      );
      const nextRetryAt = tunnel.status().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();

      await vi.advanceTimersByTimeAsync(nextRetryAt! - Date.now());
      expect(read).toHaveBeenCalledTimes(2);
      expect(fakeWebSockets.options[0]?.headers).toEqual({
        authorization: "Bearer bbcred_server",
      });
    } finally {
      tunnel.stop();
      vi.useRealTimers();
      await fakeHost.harness.dispose();
    }
  });

  it("closes on sign-out or when remote access turns off, and redials when it turns back on", async () => {
    const { fakeHost, read, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      await socketCount(1);
      const first = fakeWebSockets.instances[0]!;
      first.emit("open");
      const terminate = vi.spyOn(first, "terminate");

      tunnel.setEnabled(false);
      expect(terminate).toHaveBeenCalledOnce();
      expect(tunnel.status()).toMatchObject({
        paired: true,
        enabled: false,
        state: "disconnected",
      });

      tunnel.setEnabled(true);
      await socketCount(2);
      expect(read).toHaveBeenCalledTimes(2);
      const second = fakeWebSockets.instances[1]!;
      const terminateSecond = vi.spyOn(second, "terminate");

      tunnel.setAccount(null);
      expect(terminateSecond).toHaveBeenCalledOnce();
      expect(tunnel.status()).toMatchObject({
        paired: false,
        state: "disconnected",
        url: null,
      });
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });
});
