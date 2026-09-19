// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import { BottomAnchorContext } from "@/components/ui/bottom-anchored-scroll-body.js";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineSurface } from "./ThreadTimelineSurface";

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: undefined }),
}));

vi.mock("./ThreadTimelineRows.js", () => ({
  ThreadTimelineRows: ({ timelineRows }: { timelineRows: TimelineRow[] }) => (
    <div>
      {timelineRows.map((row) => (
        <div key={row.id}>{row.kind === "conversation" ? row.text : row.id}</div>
      ))}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThreadTimelineSurface load-older control", () => {
  it("offers Show latest for held history without a composer or bottom-anchor context", () => {
    const showLatest = vi.fn();
    const surface = (historyUnrefreshed: boolean) => (
      <ThreadTimelineSurface
        activeThinking={null}
        contextBoundarySeq={null}
        historyUnrefreshed={historyUnrefreshed}
        isThreadTimelinePending={false}
        onShowLatestTimeline={showLatest}
        showOngoingIndicator={false}
        threadId="thread-1"
        threadRuntimeDisplayStatus="idle"
        timelineError={false}
        timelineRows={[
          conversationRow({ id: "cached", text: "Previously loaded reply" }),
        ]}
        workspaceRootPath={undefined}
      />
    );
    const view = render(surface(true));
    expect(screen.getByText("Previously loaded reply")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show latest" }));
    expect(showLatest).toHaveBeenCalledTimes(1);
    view.rerender(surface(false));
    expect(screen.queryByRole("button", { name: "Show latest" })).toBeNull();
  });

  it("keeps cached messages readable when refresh fails and offers a bounded retry", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const surface = (isRefreshingHistory: boolean) => (
      <ThreadTimelineSurface
        activeThinking={null}
        contextBoundarySeq={null}
        historyRefreshError={new Error("Network offline")}
        historyUnrefreshed
        isRefreshingHistory={isRefreshingHistory}
        isThreadTimelinePending={false}
        onRefreshHistory={refresh}
        showOngoingIndicator={false}
        threadId="thread-1"
        threadRuntimeDisplayStatus="idle"
        timelineError
        timelineRows={[
          conversationRow({ id: "cached", text: "Previously loaded reply" }),
        ]}
        workspaceRootPath={undefined}
      />
    );
    const view = render(surface(false));

    expect(screen.getByText("Previously loaded reply")).not.toBeNull();
    expect(screen.queryByText("Failed to load timeline")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Couldn't refresh history",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledTimes(1);

    view.rerender(surface(true));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Refreshing…" })
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Previously loaded reply")).not.toBeNull();
  });

  it("resumes auto-loading after a context boundary replaces a timeline whose older page failed", async () => {
    const intersectionCallbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallbacks.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const emitLatestSentinelIntersection = () => {
      act(() => {
        intersectionCallbacks.at(-1)?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
    };
    const scrollElement = document.createElement("div");
    vi.spyOn(scrollElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 500),
    );
    const anchor = {
      captureScrollAnchor: vi.fn(),
      getScrollElement: () => scrollElement,
      isAtBottom: false,
      scrollElementIntoView: vi.fn(),
      scrollElementIntoViewClampedToMaxScroll: vi.fn(),
      scrollToBottom: vi.fn(),
    };
    const onLoadOlderRows = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Server error"))
      .mockReturnValue(new Promise(() => {}));
    const surface = (contextBoundarySeq: number | null) => (
      <BottomAnchorContext.Provider value={anchor}>
        <ThreadTimelineSurface
          activeThinking={null}
          contextBoundarySeq={contextBoundarySeq}
          hasOlderTimelineRows
          isThreadTimelinePending={false}
          onLoadOlderRows={onLoadOlderRows}
          showOngoingIndicator={false}
          threadId="thread-1"
          threadRuntimeDisplayStatus="idle"
          timelineError={false}
          timelineRows={[]}
          workspaceRootPath={undefined}
        />
      </BottomAnchorContext.Provider>
    );
    const view = render(surface(null));

    emitLatestSentinelIntersection();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Load older messages" }),
      ).not.toBeNull();
    });

    view.rerender(surface(10));
    expect(screen.getByRole("status")).not.toBeNull();

    emitLatestSentinelIntersection();
    expect(onLoadOlderRows).toHaveBeenCalledTimes(2);
  });
});
