import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { notificationTraceInjection } from "./injection";

function install() {
  const records: Record<string, unknown>[] = [];
  const frames: (() => void)[] = [];
  let mutate = () => {};
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ maxSeq: 42 }), {
        headers: { date: "Mon, 21 Sep 2026 12:00:00 GMT" },
      }),
  );
  const window = {
    fetch,
    ReactNativeWebView: {
      postMessage: (raw: string) => records.push(JSON.parse(raw)),
    },
  };
  runInNewContext(notificationTraceInjection, {
    window,
    URL,
    Date,
    performance,
    location: { pathname: "/projects/proj_test/threads/thr_test" },
    document: {
      visibilityState: "visible",
      addEventListener() {},
      querySelectorAll: () => [
        { textContent: "PRIVATE RESPONSE", getAttribute: () => "row_1" },
      ],
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        mutate = callback;
      }
      observe() {}
    },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  return { records, frames, mutate, window, fetch };
}

describe("notification diagnostic injection", () => {
  it("preserves the real request and response while recording completion sequence without content", async () => {
    const host = install();
    const signal = new AbortController().signal;
    const request = host.window.fetch(
      "https://server/api/v1/threads/thr_test/timeline",
      { signal },
    );
    expect(request).toBe(host.fetch.mock.results[0]?.value);
    expect(host.fetch).toHaveBeenCalledWith(
      "https://server/api/v1/threads/thr_test/timeline",
      { signal },
    );
    const response = await request;
    expect(await response.json()).toEqual({ maxSeq: 42 });
    await vi.waitFor(() =>
      expect(host.records).toContainEqual(
        expect.objectContaining({ stage: "timeline-body", maxSeq: 42 }),
      ),
    );
    while (host.frames.length) host.frames.shift()?.();
    expect(host.records).toContainEqual(
      expect.objectContaining({
        stage: "timeline-dom-frame",
        rowCount: 1,
        textLength: 16,
      }),
    );
    expect(JSON.stringify(host.records)).not.toContain("PRIVATE RESPONSE");
    host.mutate();
    while (host.frames.length) host.frames.shift()?.();
    expect(
      host.records.filter((row) => row.stage === "timeline-dom-frame"),
    ).toHaveLength(1);
  });

  it("passes unrelated requests through without logging their URL or credentials", async () => {
    const host = install();
    await host.window.fetch("https://server/private?token=SECRET");
    expect(host.records.map((row) => row.stage)).toEqual(["page-start"]);
    expect(JSON.stringify(host.records)).not.toContain("SECRET");
  });
});
