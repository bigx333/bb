// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { BottomAnchorContext } from "@/components/ui/bottom-anchored-scroll-body";
import { ThreadTimelineLatestContext } from "@/components/thread/timeline/ThreadTimelineLatestContext";
import { ThreadTimelineScrollToBottomButton } from "./ThreadTimelineScrollToBottomButton";

afterEach(cleanup);

it("switches held history to the latest rows before scrolling the footer to the bottom", () => {
  const displayedAtScroll: string[] = [];
  const showLatestTimeline = vi.fn();
  const bottomAnchor = {
    captureScrollAnchor: vi.fn(),
    getScrollElement: () => null,
    isAtBottom: true,
    scrollElementIntoView: vi.fn(),
    scrollElementIntoViewClampedToMaxScroll: vi.fn(),
    scrollToBottom: () => {
      displayedAtScroll.push(screen.getByTestId("rows").textContent ?? "");
    },
  };
  function Timeline() {
    const [historyUnrefreshed, setHistoryUnrefreshed] = useState(true);
    return (
      <BottomAnchorContext.Provider value={bottomAnchor}>
        <ThreadTimelineLatestContext.Provider
          value={{
            historyUnrefreshed,
            showLatestTimeline: () => {
              showLatestTimeline();
              setHistoryUnrefreshed(false);
            },
          }}
        >
          <div data-testid="rows">
            {historyUnrefreshed ? "Saved window" : "Current latest window"}
          </div>
          <ThreadTimelineScrollToBottomButton active={false} />
        </ThreadTimelineLatestContext.Provider>
      </BottomAnchorContext.Provider>
    );
  }
  render(<Timeline />);

  fireEvent.click(
    screen.getByRole("button", { name: "Scroll to latest event" }),
  );

  expect(showLatestTimeline).toHaveBeenCalledTimes(1);
  expect(displayedAtScroll).toEqual(["Current latest window"]);
});
