// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  hasSingleUseRootComposeTargetState,
  shouldStartComposingFromLocationState,
} from "@/views/RootComposeView";
import { useCreateThreadInEnvironment } from "./useCreateThreadInEnvironment";

const navigate = vi.fn();

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteNavigate: () => navigate,
}));

vi.mock("@/lib/root-compose-selection", () => ({
  useSetRootComposeProjectId: () => vi.fn(),
  useRootComposeProjectId: () => ["proj_personal", vi.fn()],
}));

vi.mock("@/lib/drafts/resource-runtime", () => ({
  createNewThreadDraft: () => "drf_environment_fixture",
}));

describe("useCreateThreadInEnvironment", () => {
  it("navigates with state that opens the composer and seeds the environment", () => {
    navigate.mockClear();
    const { result } = renderHook(() =>
      useCreateThreadInEnvironment({
        projectId: "proj_personal",
        environmentId: "env_1",
      }),
    );

    result.current();

    expect(navigate.mock.calls[0][0]).toBe("/?draft=drf_environment_fixture");
    const state = navigate.mock.calls[0][1].state;
    expect(shouldStartComposingFromLocationState(state)).toBe(true);
    expect(hasSingleUseRootComposeTargetState(state)).toBe(true);
  });
});
