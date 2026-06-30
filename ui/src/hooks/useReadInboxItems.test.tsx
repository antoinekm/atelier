// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useReadInboxItems } from "./useInboxBadge";
import { loadReadInboxItems } from "../lib/inbox";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let captured: ReturnType<typeof useReadInboxItems> | null = null;
let cleanup: (() => void) | null = null;

function Harness() {
  captured = useReadInboxItems();
  return null;
}

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
  cleanup = () => {
    root.unmount();
    container.remove();
  };
}

describe("useReadInboxItems", () => {
  beforeEach(() => {
    localStorage.clear();
    captured = null;
    cleanup = null;
  });
  afterEach(() => {
    cleanup?.();
    cleanup = null;
    localStorage.clear();
  });

  it("marks an inbox item read and persists it to localStorage", async () => {
    await render();
    await act(async () => {
      captured!.markRead("approval:abc");
    });
    expect(captured!.readItems.has("approval:abc")).toBe(true);
    expect(loadReadInboxItems().has("approval:abc")).toBe(true);
  });

  it("keeps a stable markRead reference across re-renders (safe as an effect dependency)", async () => {
    await render();
    const firstMarkRead = captured!.markRead;
    // marking triggers a state change and a re-render
    await act(async () => {
      captured!.markRead("approval:xyz");
    });
    expect(captured!.markRead).toBe(firstMarkRead);
  });
});
