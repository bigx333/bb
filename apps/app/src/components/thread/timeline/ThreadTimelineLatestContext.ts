import { createContext } from "react";

export const ThreadTimelineLatestContext = createContext<{
  historyUnrefreshed: boolean;
  showLatestTimeline: () => void;
} | null>(null);
