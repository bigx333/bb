import { expect, it, vi } from "vitest";
import { defaultAppSettings, turnScope } from "@bb/domain";
import { threadTimelineResponseSchema } from "@bb/server-contract";
import * as timelineBuilder from "../../src/services/threads/timeline.js";
import { readJson } from "../helpers/json.js";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

it("reuses an unchanged large timeline and rebuilds after new events", async () => {
  await withTestHarness(async (harness) => {
    const { environment, thread } = seedThreadFixture(harness);
    const settings = await harness.app.request("/api/v1/settings/general", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...defaultAppSettings,
        providerCompletedTurnDisplay: { [thread.providerId]: "flat" },
      }),
    });
    expect(settings.status).toBe(200);
    const scope = {
      environmentId: environment.id,
      threadId: thread.id,
      providerThreadId: "response-reuse",
      scope: turnScope("turn-1"),
    };
    let sequence = 1;
    seedEvent(harness.deps, {
      ...scope,
      sequence: sequence++,
      type: "turn/started",
      data: {},
    });
    for (let index = 0; index < 110; index += 1) {
      seedEvent(harness.deps, {
        ...scope,
        sequence: sequence++,
        type: "item/completed",
        data: {
          item: {
            id: `tool-${index}`,
            type: "toolCall",
            tool: "read",
            status: "completed",
            result: "file contents",
          },
        },
      });
      seedEvent(harness.deps, {
        ...scope,
        sequence: sequence++,
        type: "item/completed",
        data: {
          item: {
            id: `message-${index}`,
            type: "agentMessage",
            text: `Read file ${index}.`,
          },
        },
      });
    }
    seedEvent(harness.deps, {
      ...scope,
      sequence: sequence++,
      type: "turn/completed",
      data: { status: "completed" },
    });
    const fetchTimeline = async () => {
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(response.status).toBe(200);
      return threadTimelineResponseSchema.parse(await readJson(response));
    };
    const build = vi.spyOn(timelineBuilder, "buildThreadTimelineWithProfile");
    try {
      const first = await fetchTimeline();
      expect(first.rows.length).toBeGreaterThan(200);
      build.mockClear();
      expect(await fetchTimeline()).toEqual(first);
      expect(build).not.toHaveBeenCalled();
      seedEvent(harness.deps, {
        ...scope,
        sequence,
        type: "item/completed",
        data: {
          item: {
            id: "late-message",
            type: "agentMessage",
            text: "Late result",
          },
        },
      });
      const updated = await fetchTimeline();
      expect(updated.maxSeq).toBe(sequence);
      expect(updated.rows).not.toEqual(first.rows);
      expect(build).toHaveBeenCalledTimes(1);
    } finally {
      build.mockRestore();
    }
  });
});
