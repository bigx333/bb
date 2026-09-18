import { useContext, useLayoutEffect, useState } from "react";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { ScrollToBottomButton } from "@/components/ui/scroll-to-bottom-button.js";
import { ThreadTimelineLatestContext } from "@/components/thread/timeline/ThreadTimelineLatestContext";

export function ThreadTimelineScrollToBottomButton({
  active,
}: {
  active: boolean;
}) {
  const bottomAnchor = useBottomAnchoredScroll();
  const latestTimeline = useContext(ThreadTimelineLatestContext);
  const [scrollAfterReplacement, setScrollAfterReplacement] = useState(false);

  useLayoutEffect(() => {
    if (!scrollAfterReplacement) return;
    bottomAnchor?.scrollToBottom();
    setScrollAfterReplacement(false);
  }, [bottomAnchor, scrollAfterReplacement]);

  if (!bottomAnchor) return null;

  return (
    <ScrollToBottomButton
      visible={
        !bottomAnchor.isAtBottom || latestTimeline?.historyUnrefreshed === true
      }
      active={active}
      onClick={() => {
        if (latestTimeline?.historyUnrefreshed) {
          latestTimeline.showLatestTimeline();
          setScrollAfterReplacement(true);
          return;
        }
        bottomAnchor.scrollToBottom();
      }}
    />
  );
}
