// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, expect, it, vi } from "vitest";
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
  const onDone = vi.fn();
  render(
    <Provider store={store}>
      <ThreadRowActionsCustomize onDone={onDone} variant="card" />
    </Provider>,
  );
  return { store, onDone };
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

it("appends a newly shown action and removes a hidden one", () => {
  const { store } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect(store.get(threadRowActionsAtom)).toEqual(["pin", "archive", "rename"]);
  fireEvent.click(screen.getByRole("button", { name: "Pin" }));
  expect(store.get(threadRowActionsAtom)).toEqual(["archive", "rename"]);
});

it("greys out the rest once three actions are shown and frees them again", () => {
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
  expect(copy.hasAttribute("disabled")).toBe(false);
});

it("finishes from Done without changing the selection", () => {
  const { store, onDone } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onDone).toHaveBeenCalledOnce();
  expect(store.get(threadRowActionsAtom)).toEqual(["pin", "archive"]);
});
