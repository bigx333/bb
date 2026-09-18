import type { ReactNode } from "react";
import { isRunningThreadRuntimeDisplayStatus } from "@bb/client-core";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Skeleton } from "@bb/shared-ui/skeleton";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { ConversationTimeline } from "@/components/ui/conversation.js";
import { useThread } from "@/hooks/queries/thread-queries";
import { BbHttpError } from "@/lib/sdk";
import {
  ThreadTimelineSurface,
  type ThreadTimelineSurfaceProps,
} from "./ThreadTimelineSurface.js";
import {
  useThreadTimelineController,
  type UseThreadTimelineControllerResult,
} from "./useThreadTimelineController.js";

interface ThreadTimelinePanelContentProps {
  isTurnSubmitting?: boolean;
  leadingContent?: ReactNode;
  onMessageAddToChat?: ThreadTimelineSurfaceProps["onMessageAddToChat"];
  onSelectionAddToChat?: ThreadTimelineSurfaceProps["onSelectionAddToChat"];
  consumerMessageActions?: ThreadTimelineSurfaceProps["consumerMessageActions"];
  includePluginMessageActions?: ThreadTimelineSurfaceProps["includePluginMessageActions"];
  onOpenLink?: ThreadTimelineSurfaceProps["onOpenLink"];
  onOpenLocalFileLink?: ThreadTimelineSurfaceProps["onOpenLocalFileLink"];
  projectId?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  surfaceKey?: string;
  threadId: string;
  timeline?: UseThreadTimelineControllerResult;
  workspaceRootPath?: string;
}

export function ThreadTimelinePanelContent({
  isTurnSubmitting = false,
  leadingContent,
  onMessageAddToChat,
  onSelectionAddToChat,
  consumerMessageActions,
  includePluginMessageActions,
  onOpenLink,
  onOpenLocalFileLink,
  projectId,
  resolveMentionLink,
  surfaceKey,
  threadId,
  timeline,
  workspaceRootPath,
}: ThreadTimelinePanelContentProps) {
  const threadQuery = useThread(threadId);
  const threadAccessError =
    threadQuery.error instanceof BbHttpError &&
    [401, 403, 404].includes(threadQuery.error.status)
      ? threadQuery.error
      : null;
  const ownedTimeline = useThreadTimelineController({
    enabled: timeline === undefined && threadAccessError === null,
    surfaceKey,
    threadId,
  });
  const resolvedTimeline = timeline ?? ownedTimeline;
  const displayStatus = threadQuery.data?.runtime.displayStatus ?? "idle";
  const isProvisioningDisplayStatus =
    displayStatus === "provisioning" || displayStatus === "starting";
  const hasActiveBackgroundWork =
    resolvedTimeline.activeWorkflows.length > 0 ||
    resolvedTimeline.activeBackgroundCommands.length > 0 ||
    (threadQuery.data?.activeBackgroundAgentCount ?? 0) > 0;
  const backgroundOnlyIndicatorLabel =
    displayStatus === "idle" && hasActiveBackgroundWork
      ? "Background work running"
      : undefined;
  const ongoingIndicatorLabel =
    displayStatus === "host-reconnecting"
      ? "Waiting for reconnection"
      : isProvisioningDisplayStatus
        ? "Provisioning thread..."
        : backgroundOnlyIndicatorLabel;
  const showOngoingIndicator =
    threadQuery.data?.status !== "stopping" &&
    (isProvisioningDisplayStatus ||
      (!resolvedTimeline.timelineLoading &&
        (isTurnSubmitting ||
          isRunningThreadRuntimeDisplayStatus(displayStatus) ||
          backgroundOnlyIndicatorLabel !== undefined)));
  const timelineRows = resolvedTimeline.timelineRows;
  if (threadAccessError !== null) {
    return (
      <ConversationTimeline className="flex-1">
        {leadingContent}
        <EmptyStatePanel className="mx-2 rounded-lg">
          This thread is no longer available.
        </EmptyStatePanel>
      </ConversationTimeline>
    );
  }

  return (
    <ThreadTimelineSurface
      activeThinking={resolvedTimeline.activeThinking}
      contextBoundarySeq={resolvedTimeline.contextBoundarySeq}
      hasOlderTimelineRows={resolvedTimeline.hasOlderTimelineRows}
      historyRefreshError={resolvedTimeline.historyRefreshError}
      historyUnrefreshed={resolvedTimeline.historyUnrefreshed}
      historyReplacementKey={resolvedTimeline.historyReplacementKey}
      isLoadingOlderTimelineRows={resolvedTimeline.isLoadingOlderTimelineRows}
      isRefreshingHistory={resolvedTimeline.isRefreshingHistory}
      isThreadTimelinePending={
        resolvedTimeline.timelineLoading &&
        timelineRows.length === 0 &&
        !showOngoingIndicator
      }
      timelineError={
        Boolean(resolvedTimeline.timelineError) && timelineRows.length === 0
      }
      loadingContent={<ThreadTimelinePanelLoadingSkeleton />}
      leadingContent={leadingContent}
      onMessageAddToChat={onMessageAddToChat}
      onSelectionAddToChat={onSelectionAddToChat}
      consumerMessageActions={consumerMessageActions}
      includePluginMessageActions={includePluginMessageActions}
      onLoadOlderRows={resolvedTimeline.loadOlderTimelineRows}
      onRefreshHistory={resolvedTimeline.refreshHistory}
      onShowLatestTimeline={resolvedTimeline.showLatestTimeline}
      onOpenLink={onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      projectId={projectId}
      resolveMentionLink={resolveMentionLink}
      showOngoingIndicator={showOngoingIndicator}
      ongoingIndicatorLabel={ongoingIndicatorLabel}
      timelineErrorClassName="mx-2 mt-4 text-destructive"
      timelineRows={timelineRows}
      threadId={threadId}
      threadRuntimeDisplayStatus={displayStatus}
      workspaceRootPath={workspaceRootPath}
    />
  );
}

function ThreadTimelinePanelLoadingSkeleton() {
  return (
    <div className="space-y-2 px-2 pt-2">
      <Skeleton className="h-4 w-3/4 rounded-sm" />
      <Skeleton className="h-4 w-2/3 rounded-sm" />
      <Skeleton className="h-4 w-1/2 rounded-sm" />
    </div>
  );
}
