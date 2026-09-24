// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, expect, it } from "vitest";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { threadRowActionsAtom } from "../preferences/atoms.js";

installTestPluginRuntime();
const { ThreadRowActionsCustomize } = await import(
  "./ThreadRowActionsCustomize.js"
);

afterEach(() => {
  cleanup();
});

function setup() {
  const store = createStore();
  store.set(threadRowActionsAtom, ["pin", "archive"]);
  render(
    <Provider store={store}>
      <ThreadRowActionsCustomize onDone={() => {}} variant="card" />
    </Provider>,
  );
  return { store };
}

it("lists shown actions first in their order, then the rest", () => {
  setup();
  expect(
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-sidebar-customize-item]"),
    ).map((item) => item.dataset.sidebarCustomizeItem),
  ).toEqual(["pin", "archive", "read", "rename", "copyLink", "split"]);
  expect(
    screen
      .getByRole("checkbox", { name: "Show Pin on thread rows" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

it("appends shown actions, greys out the rest at three, and frees them on removal", () => {
  const { store } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect(store.get(threadRowActionsAtom)).toEqual(["pin", "archive", "rename"]);
  const copy = screen.getByRole("checkbox", {
    name: "Show Copy thread link on thread rows",
  });
  expect(copy.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Copy thread link" }));
  expect(store.get(threadRowActionsAtom)).toEqual(["pin", "archive", "rename"]);
  fireEvent.click(screen.getByRole("button", { name: "Pin" }));
  expect(store.get(threadRowActionsAtom)).toEqual(["archive", "rename"]);
  expect(copy.hasAttribute("disabled")).toBe(false);
});
