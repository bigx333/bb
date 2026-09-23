import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BbDesktopBrowserTarget } from "@bb/desktop-contract";
import { Button } from "@bb/shared-ui/button";
import type { BrowserFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { getDesktopBrowserApi } from "@/lib/bb-desktop";
import {
  BrowserTabContent,
  type BrowserAddressFocusRequest,
} from "./BrowserTabContent";
import {
  createBrowserViewVisibilityCoordinator,
  destroyPersistedBrowserView,
  hidePersistedBrowserViewsForThread,
} from "./browserViewVisibilityCoordinator";
import type { UpdateBrowserTabArgs } from "./useThreadFileTabs";

interface BrowserTabDeckProps {
  browserTabs: readonly BrowserFixedPanelTab[];
  activeBrowserTabId: string | null;
  addressFocusRequest?: BrowserAddressFocusRequest | null;
  onAddressFocusRequestConsumed?: (request: BrowserAddressFocusRequest) => void;
  environmentId: string | null;
  canShowNativeBrowserView: boolean;
  canHandleBrowserCommands?: boolean;
  onNativeFocus?: () => void;
  threadId: string;
  onUpdate: (args: UpdateBrowserTabArgs) => void;
}

interface BrowserTabLifecycleObserverProps {
  browserTabs: readonly BrowserFixedPanelTab[];
  threadId: string;
}

interface BrowserTabIdSnapshot {
  tabIds: ReadonlySet<string>;
  threadId: string;
}

interface BuildBrowserTabIdSetArgs {
  browserTabs: readonly BrowserFixedPanelTab[];
}

const DESKTOP_BROWSER_TARGET_RETRY_MS = 1_000;

export function buildBrowserTabIdSet({
  browserTabs,
}: BuildBrowserTabIdSetArgs): ReadonlySet<string> {
  return new Set(browserTabs.map((tab) => tab.id));
}

export function BrowserTabLifecycleObserver({
  browserTabs,
  threadId,
}: BrowserTabLifecycleObserverProps) {
  const desktopBrowser = useMemo(() => getDesktopBrowserApi(), []);
  const previousTabIdsRef = useRef<BrowserTabIdSnapshot | null>(null);

  useLayoutEffect(
    () => () => {
      hidePersistedBrowserViewsForThread({ desktopBrowser, threadId });
    },
    [desktopBrowser, threadId],
  );

  useEffect(() => {
    const tabIds = buildBrowserTabIdSet({ browserTabs });
    const previous = previousTabIdsRef.current;
    if (
      desktopBrowser !== null &&
      previous !== null &&
      previous.threadId === threadId
    ) {
      for (const tabId of previous.tabIds) {
        if (!tabIds.has(tabId)) {
          destroyPersistedBrowserView({ desktopBrowser, tabId });
        }
      }
    }
    previousTabIdsRef.current = { tabIds, threadId };
  }, [browserTabs, desktopBrowser, threadId]);

  return null;
}

export function selectActiveBrowserTab(
  browserTabs: readonly BrowserFixedPanelTab[],
  activeBrowserTabId: string | null,
): BrowserFixedPanelTab | null {
  if (activeBrowserTabId === null) {
    return null;
  }
  return browserTabs.find((tab) => tab.id === activeBrowserTabId) ?? null;
}

export function BrowserTabDeck({
  browserTabs,
  activeBrowserTabId,
  addressFocusRequest = null,
  onAddressFocusRequestConsumed,
  environmentId,
  canShowNativeBrowserView,
  canHandleBrowserCommands = canShowNativeBrowserView,
  onNativeFocus,
  threadId,
  onUpdate,
}: BrowserTabDeckProps) {
  const desktopBrowser = useMemo(() => getDesktopBrowserApi(), []);
  const visibilityCoordinator = useMemo(
    () =>
      desktopBrowser === null
        ? null
        : createBrowserViewVisibilityCoordinator(desktopBrowser),
    [desktopBrowser],
  );

  const activeBrowserTab = selectActiveBrowserTab(
    browserTabs,
    activeBrowserTabId,
  );
  const target = activeBrowserTab?.desktopTarget;
  const targetHostId = target?.hostId;
  const [verifiedTarget, setVerifiedTarget] =
    useState<BbDesktopBrowserTarget | null>(null);
  useEffect(() => {
    let current = true;
    let retryTimer: number | null = null;
    setVerifiedTarget(null);
    const getTarget = desktopBrowser?.getTarget;
    if (targetHostId !== undefined && getTarget !== undefined) {
      const verifyTarget = () => {
        void getTarget()
          .then((actual) => {
            if (!current) return;
            setVerifiedTarget(actual);
            if (actual === null) {
              retryTimer = window.setTimeout(
                verifyTarget,
                DESKTOP_BROWSER_TARGET_RETRY_MS,
              );
            }
          })
          .catch(() => {
            if (current) {
              retryTimer = window.setTimeout(
                verifyTarget,
                DESKTOP_BROWSER_TARGET_RETRY_MS,
              );
            }
          });
      };
      verifyTarget();
    }
    return () => {
      current = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [desktopBrowser, targetHostId, target?.instanceId, target?.generation]);
  if (activeBrowserTab === null) {
    return null;
  }
  if (
    target !== undefined &&
    (verifiedTarget?.hostId !== target.hostId ||
      verifiedTarget.instanceId !== target.instanceId ||
      verifiedTarget.generation !== target.generation)
  ) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
        <div className="shrink-0 px-3 py-1.5">
          <input
            aria-label="Saved URL"
            readOnly
            value={activeBrowserTab.url}
            onFocus={(event) => event.currentTarget.select()}
            className="h-8 w-full rounded-full border border-border/70 bg-background/70 px-3 font-mono text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <p>This BB Browser tab is disconnected.</p>
          {verifiedTarget !== null && canHandleBrowserCommands && (
            <Button
              variant="outline"
              onClick={() =>
                onUpdate({
                  tabId: activeBrowserTab.id,
                  url: activeBrowserTab.url,
                  title: activeBrowserTab.title,
                  reopenOnThisDesktop: true,
                })
              }
            >
              Reopen tab
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
      <BrowserTabContent
        key={activeBrowserTab.id}
        tabId={activeBrowserTab.id}
        existingOnly={target === undefined ? undefined : true}
        initialUrl={activeBrowserTab.url}
        addressFocusRequest={
          addressFocusRequest?.tabId === activeBrowserTab.id
            ? addressFocusRequest
            : null
        }
        onAddressFocusRequestConsumed={onAddressFocusRequestConsumed}
        canShowNativeBrowserView={canShowNativeBrowserView}
        canHandleBrowserCommands={canHandleBrowserCommands}
        onNativeFocus={onNativeFocus}
        visibilityCoordinator={visibilityCoordinator}
        environmentId={environmentId}
        threadId={threadId}
        onUpdate={onUpdate}
      />
    </div>
  );
}
