import { useAtom } from "jotai";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  THREAD_ROW_ACTION_IDS,
  THREAD_ROW_ACTION_LIMIT,
  type ThreadRowActionId,
} from "../../shared/preferences.js";
import { arrayMove } from "../model/array-move.js";
import { threadRowActionsAtom } from "../preferences/atoms.js";
import { SidebarVisibilityCustomize } from "./SidebarVisibilityCustomize.js";

const ROW_ACTION_ITEMS: Record<
  ThreadRowActionId,
  { title: string; icon: IconName }
> = {
  archive: { title: "Archive", icon: "Archive" },
  pin: { title: "Pin", icon: "Pin" },
  read: { title: "Mark read / unread", icon: "MailOpen" },
  rename: { title: "Rename", icon: "Edit" },
  copyLink: { title: "Copy thread link", icon: "Copy" },
  split: { title: "Open in split", icon: "Columns2" },
};

function isThreadRowActionId(id: string): id is ThreadRowActionId {
  return (THREAD_ROW_ACTION_IDS as readonly string[]).includes(id);
}

export function ThreadRowActionsCustomize({
  onDone,
  variant,
}: {
  onDone: () => void;
  variant: "compact" | "card";
}) {
  const [enabled, setEnabled] = useAtom(threadRowActionsAtom);
  const atLimit = enabled.length >= THREAD_ROW_ACTION_LIMIT;
  const items = [
    ...enabled,
    ...THREAD_ROW_ACTION_IDS.filter((id) => !enabled.includes(id)),
  ].map((id) => ({
    id,
    title: ROW_ACTION_ITEMS[id].title,
    icon: <Icon name={ROW_ACTION_ITEMS[id].icon} aria-hidden="true" />,
    disabled: atLimit && !enabled.includes(id),
  }));
  return (
    <SidebarVisibilityCustomize
      items={items}
      visibleIds={enabled}
      reorderableIds={enabled}
      checkboxLabel={(title) => `Show ${title} on thread rows`}
      onVisibleChange={(id, visible) => {
        if (!isThreadRowActionId(id)) return;
        setEnabled((current) =>
          visible
            ? current.includes(id) || current.length >= THREAD_ROW_ACTION_LIMIT
              ? current
              : [...current, id]
            : current.filter((key) => key !== id),
        );
      }}
      onReorder={(activeId, overId) => {
        if (!isThreadRowActionId(activeId) || !isThreadRowActionId(overId))
          return;
        setEnabled((current) => {
          const from = current.indexOf(activeId);
          const to = current.indexOf(overId);
          if (from === -1 || to === -1 || from === to) return current;
          return arrayMove(current, from, to);
        });
      }}
      onDone={onDone}
      title="Customize row actions"
      listLabel="Row actions"
      variant={variant}
      testIdPrefix="sidebar-thread-list-row-actions"
    />
  );
}
