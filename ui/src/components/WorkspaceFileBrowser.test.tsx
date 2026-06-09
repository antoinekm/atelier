// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { Project, ProjectWorkspace, WorkspaceFileListItem, WorkspaceFileListResponse } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileBrowser, describeUnavailable } from "./WorkspaceFileBrowser";

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: (options: unknown) => useQueryMock(options),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createItem(overrides: Partial<WorkspaceFileListItem> = {}): WorkspaceFileListItem {
  return {
    kind: "file",
    provider: "git_worktree",
    title: "IssueDetail.tsx",
    relativePath: "ui/src/pages/IssueDetail.tsx",
    displayPath: "ui/src/pages/IssueDetail.tsx",
    workspaceLabel: "Isolated workspace",
    workspaceKind: "execution_workspace",
    workspaceId: "ws-1",
    contentType: "text/plain; charset=utf-8",
    byteSize: 2048,
    modifiedAt: new Date(Date.now() - 120_000).toISOString(),
    previewKind: "text",
    capabilities: { preview: true, download: false, listChildren: false },
    ...overrides,
  };
}

function availableResponse(items: WorkspaceFileListItem[], truncated = false): WorkspaceFileListResponse {
  return {
    kind: "workspace_file_list",
    state: "available",
    workspace: {
      provider: "git_worktree",
      workspaceLabel: "Isolated workspace",
      workspaceKind: "execution_workspace",
      workspaceId: "ws-1",
    },
    query: { workspace: "auto", mode: "changed", q: null, limit: 100 },
    items,
    scannedCount: items.length,
    truncated,
  };
}

function createWorkspace(overrides: Partial<ProjectWorkspace> = {}): ProjectWorkspace {
  return {
    id: "workspace-content",
    companyId: "company-1",
    projectId: "project-content",
    name: "Paperclip Content",
    sourceType: "local_path",
    cwd: "/srv/paperclip/home/paperclipai/paperclip-content",
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    isPrimary: true,
    createdAt: new Date("2026-06-08T00:00:00.000Z"),
    updatedAt: new Date("2026-06-08T00:00:00.000Z"),
    ...overrides,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const workspace = createWorkspace();
  return {
    id: "project-content",
    companyId: "company-1",
    urlKey: "paperclip-content",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Paperclip Content",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: null,
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: workspace.id,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: workspace.cwd,
      managedFolder: "",
      effectiveLocalFolder: workspace.cwd ?? "",
      origin: "local_folder",
    },
    workspaces: [workspace],
    primaryWorkspace: workspace,
    archivedAt: null,
    createdAt: new Date("2026-06-08T00:00:00.000Z"),
    updatedAt: new Date("2026-06-08T00:00:00.000Z"),
    ...overrides,
  };
}

function unavailableResponse(reason: string): WorkspaceFileListResponse {
  return {
    kind: "workspace_file_list",
    state: "unavailable",
    unavailableReason: reason,
    workspace: null,
    query: { workspace: "auto", mode: "changed", q: null, limit: 100 },
    items: [],
    scannedCount: 0,
    truncated: false,
  };
}

function ok<T>(data: T) {
  return { data, isFetching: false, isError: false, error: null, refetch: vi.fn() };
}

describe("WorkspaceFileBrowser", () => {
  let container: HTMLDivElement;
  const roots: Root[] = [];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    useQueryMock.mockReset();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => {
        root.unmount();
      });
    }
    container.remove();
    vi.restoreAllMocks();
  });

  function renderBrowser(onOpen = vi.fn(), props: Partial<ComponentProps<typeof WorkspaceFileBrowser>> = {}) {
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(<WorkspaceFileBrowser issueId="issue-1" onOpen={onOpen} {...props} />);
    });
    return { root, onOpen };
  }

  it("renders the Recently changed files as a tree and opens a row with its relative path", () => {
    useQueryMock.mockReturnValue(
      ok(availableResponse([createItem(), createItem({ relativePath: "README.md", displayPath: "README.md" })])),
    );

    const { onOpen } = renderBrowser();

    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(container.textContent).toContain("Isolated workspace");
    expect(container.textContent).not.toContain("Recently changed");
    expect(container.textContent).not.toContain("From Isolated workspace");

    const option = Array.from(container.querySelectorAll('[role="treeitem"]')).find(
      (el) => el.getAttribute("title") === "ui/src/pages/IssueDetail.tsx",
    );
    expect(option).not.toBeUndefined();

    act(() => {
      option!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpen).toHaveBeenCalledWith({
      path: "ui/src/pages/IssueDetail.tsx",
      workspace: "auto",
      browseFolderPath: null,
      browseQuery: null,
    });
  });

  it("groups nested paths into collapsible folder rows instead of repeating full paths", () => {
    useQueryMock.mockReturnValue(
      ok(availableResponse([
        createItem({
          title: "tweet.md",
          relativePath: "videos/90-days-paperclip/tweet.md",
          displayPath: "videos/90-days-paperclip/tweet.md",
        }),
        createItem({
          title: "90-days-paperclip-1x1.mp4",
          relativePath: "videos/90-days-paperclip/out/90-days-paperclip-1x1.mp4",
          displayPath: "videos/90-days-paperclip/out/90-days-paperclip-1x1.mp4",
          previewKind: "video",
        }),
      ])),
    );

    renderBrowser();

    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(container.textContent).toContain("videos");
    expect(container.textContent).toContain("90-days-paperclip");
    expect(container.textContent).toContain("tweet.md");
    expect(container.textContent).toContain("90-days-paperclip-1x1.mp4");
    expect(container.textContent).not.toContain("videos/90-days-paperclip/tweet.md");

    const videosFolder = Array.from(container.querySelectorAll('button[role="treeitem"]')).find(
      (el) => el.getAttribute("title") === "videos",
    );
    expect(videosFolder).not.toBeUndefined();
    act(() => {
      videosFolder!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).not.toContain("tweet.md");
  });

  it("can render without autofocus when embedded beside a preview", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem()])));
    renderBrowser(vi.fn(), { autoFocusSearch: false });
    expect(container.querySelector("input")?.hasAttribute("autofocus")).toBe(false);
    expect(container.querySelector("input")?.className).toContain("max-w-full");
  });

  it("hides source controls, folder headings, workspace labels, and timestamps", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([
      createItem({
        relativePath: "videos/90-days-paperclip/tweet.md",
        displayPath: "videos/90-days-paperclip/tweet.md",
      }),
    ])));

    renderBrowser(vi.fn(), { compact: true, autoFocusSearch: false });

    expect(container.textContent).not.toContain("Source");
    expect(container.textContent).not.toContain("Workspace");
    expect(container.textContent).not.toContain("Recently changed");
    expect(container.textContent).not.toContain("Files in folder");
    expect(container.textContent).not.toContain("From Isolated workspace");
    expect(container.querySelector(".tabular-nums")).toBeNull();
    expect(container.textContent).toContain("videos");
    expect(container.textContent).toContain("tweet.md");
  });

  it("marks the selected file in the tree", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem()])));
    renderBrowser(vi.fn(), { selectedPath: "ui/src/pages/IssueDetail.tsx" });
    const selected = Array.from(container.querySelectorAll('[role="treeitem"]')).find(
      (el) => el.getAttribute("title") === "ui/src/pages/IssueDetail.tsx",
    );
    expect(selected?.getAttribute("aria-selected")).toBe("true");
  });

  it("lists the selected file's parent folder so deep-linked files appear selected", () => {
    const commandsItem = createItem({
      title: "commands.md",
      relativePath: "docs/reference/cli/commands.md",
      displayPath: "docs/reference/cli/commands.md",
      byteSize: 8192,
    });
    useQueryMock.mockReturnValue(ok(availableResponse([commandsItem])));

    renderBrowser(vi.fn(), {
      compact: true,
      autoFocusSearch: false,
      selectedPath: "docs/reference/cli/commands.md",
    });

    const listCall = useQueryMock.mock.calls.find(([options]) => options.queryKey?.[3] === "list");
    expect(listCall?.[0].queryKey[4]).toMatchObject({
      mode: "all",
      path: "docs/reference/cli",
    });
    const selected = Array.from(container.querySelectorAll('[role="treeitem"]')).find(
      (el) => el.getAttribute("title") === "docs/reference/cli/commands.md",
    );
    expect(selected?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("commands.md");
  });

  it("treats an explicit null initial folder as the workspace root", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem({
      title: "README.md",
      relativePath: "README.md",
      displayPath: "README.md",
    })])));

    renderBrowser(vi.fn(), {
      compact: true,
      autoFocusSearch: false,
      initialFolderPath: null,
      selectedPath: "docs/reference/cli/commands.md",
    });

    const listCall = useQueryMock.mock.calls.find(([options]) => options.queryKey?.[3] === "list");
    expect(listCall?.[0].queryKey[4]).toMatchObject({
      mode: "all",
      path: null,
    });
  });

  it("preserves an initial search instead of narrowing to the selected file's parent folder", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem({
      title: "FileViewerSheet.tsx",
      relativePath: "ui/src/components/FileViewerSheet.tsx",
      displayPath: "ui/src/components/FileViewerSheet.tsx",
    })])));

    renderBrowser(vi.fn(), {
      compact: true,
      autoFocusSearch: false,
      initialQuery: "FileViewerSheet",
      selectedPath: "ui/src/components/FileViewerSheet.tsx",
    });

    const listCall = useQueryMock.mock.calls.find(([options]) => options.queryKey?.[3] === "list");
    expect(listCall?.[0].queryKey[4]).toMatchObject({
      mode: "all",
      q: "FileViewerSheet",
      path: null,
    });
  });

  it("does not mark an unrelated highlighted row as selected", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([
      createItem({
        title: "vite.config.ts",
        relativePath: "ui/vite.config.ts",
        displayPath: "ui/vite.config.ts",
      }),
    ])));

    renderBrowser(vi.fn(), {
      compact: true,
      autoFocusSearch: false,
      selectedPath: "docs/reference/cli/commands.md",
    });

    const unrelated = Array.from(container.querySelectorAll('[role="treeitem"]')).find(
      (el) => el.getAttribute("title") === "ui/vite.config.ts",
    );
    expect(unrelated?.getAttribute("aria-selected")).toBe("false");
  });

  it("does not render a Recent/All toggle", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem()])));
    renderBrowser();
    expect(container.textContent).not.toContain("All files");
    expect(container.textContent).not.toContain("Recent changes / All");
  });

  it("discloses truncation in the footer", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem()], true)));
    renderBrowser();
    expect(container.textContent).toContain("refine the search to narrow");
  });

  it("opens the highlighted row when Enter is pressed in the search field", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem()])));
    const { onOpen } = renderBrowser();
    const input = container.querySelector("input")!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onOpen).toHaveBeenCalledWith({
      path: "ui/src/pages/IssueDetail.tsx",
      workspace: "auto",
      browseFolderPath: null,
      browseQuery: null,
    });
  });

  it("reports live search state for URL-backed browse preservation", async () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem()])));
    const onBrowseStateChange = vi.fn();
    renderBrowser(vi.fn(), {
      initialFolderPath: "ui/src/components",
      onBrowseStateChange,
    });
    onBrowseStateChange.mockClear();

    const input = container.querySelector("input")!;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      nativeSetter?.call(input, "FileViewerSheet");
      input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(onBrowseStateChange).toHaveBeenLastCalledWith({
      q: "FileViewerSheet",
      folderPath: "ui/src/components",
      projectId: null,
      workspaceId: null,
    });
  });

  it("shows the remote-workspace state without file rows", () => {
    useQueryMock.mockReturnValue(ok(unavailableResponse("remote_workspace")));
    renderBrowser();
    expect(container.textContent).toContain("Remote workspace preview not supported");
    expect(container.querySelector('[role="tree"]')).toBeNull();
  });

  it("shows the no-workspace state when the issue has no workspace", () => {
    useQueryMock.mockReturnValue(ok(unavailableResponse("no_workspace")));
    renderBrowser();
    expect(container.textContent).toContain("No workspace yet");
  });

  it("opens a result from a selected other project workspace", () => {
    const contentItem = createItem({
      relativePath: "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/README.md",
      displayPath: "Paperclip Content / content-os/cases/active/2026-06-06-pap-10199-bundled-skills/README.md",
      workspaceLabel: "Paperclip Content",
      workspaceKind: "project_workspace",
      workspaceId: "workspace-content",
      projectId: "project-content",
      projectName: "Paperclip Content",
    });
    useQueryMock.mockImplementation((options: { queryKey: readonly unknown[] }) => {
      if (options.queryKey[0] === "projects") return ok([createProject()]);
      return ok(availableResponse([contentItem]));
    });

    const { onOpen } = renderBrowser(vi.fn(), {
      companyId: "company-1",
      initialProjectId: "project-content",
      initialWorkspaceId: "workspace-content",
    });

    expect(container.textContent).not.toContain("Other project");
    expect(container.textContent).toContain("Paperclip Content / Paperclip Content");
    const listCall = useQueryMock.mock.calls.find(([options]) => options.queryKey?.[3] === "list");
    expect(listCall?.[0].queryKey[4]).toMatchObject({
      workspace: "project",
      projectId: "project-content",
      workspaceId: "workspace-content",
    });

    const option = Array.from(container.querySelectorAll('[role="treeitem"]')).find(
      (el) => el.getAttribute("title") === contentItem.displayPath,
    )!;
    act(() => {
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpen).toHaveBeenCalledWith({
      path: "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/README.md",
      workspace: "project",
      projectId: "project-content",
      workspaceId: "workspace-content",
      browseFolderPath: null,
      browseQuery: null,
    });
  });

  it("focuses an initial folder in a selected other project workspace", () => {
    const folderPath = "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/";
    const contentItem = createItem({
      relativePath: `${folderPath}README.md`,
      displayPath: `Paperclip Content / ${folderPath}README.md`,
      workspaceLabel: "Paperclip Content",
      workspaceKind: "project_workspace",
      workspaceId: "workspace-content",
      projectId: "project-content",
      projectName: "Paperclip Content",
    });
    useQueryMock.mockImplementation((options: { queryKey: readonly unknown[] }) => {
      if (options.queryKey[0] === "projects") return ok([createProject()]);
      return ok(availableResponse([contentItem]));
    });

    const { onOpen } = renderBrowser(vi.fn(), {
      companyId: "company-1",
      initialProjectId: "project-content",
      initialWorkspaceId: "workspace-content",
      initialFolderPath: folderPath,
    });

    expect(container.textContent).toContain("bundled-skills");
    expect(container.textContent).not.toContain(folderPath);
    expect(container.textContent).not.toContain("Files in folder");
    const listCall = useQueryMock.mock.calls.find(([options]) => options.queryKey?.[3] === "list");
    expect(listCall?.[0].queryKey[4]).toMatchObject({
      workspace: "project",
      projectId: "project-content",
      workspaceId: "workspace-content",
      path: folderPath,
    });

    const option = Array.from(container.querySelectorAll('[role="treeitem"]')).find(
      (el) => el.getAttribute("title") === contentItem.displayPath,
    )!;
    act(() => {
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpen).toHaveBeenCalledWith({
      path: `${folderPath}README.md`,
      workspace: "project",
      projectId: "project-content",
      workspaceId: "workspace-content",
      browseFolderPath: folderPath,
      browseQuery: null,
    });
  });

  it("opens sibling files with the current folder scope", () => {
    const folderPath = "docs/cli";
    const controlPlane = createItem({
      title: "control-plane-commands.md",
      relativePath: `${folderPath}/control-plane-commands.md`,
      displayPath: `${folderPath}/control-plane-commands.md`,
    });
    useQueryMock.mockReturnValue(ok(availableResponse([
      createItem({
        title: "setup-commands.md",
        relativePath: `${folderPath}/setup-commands.md`,
        displayPath: `${folderPath}/setup-commands.md`,
      }),
      controlPlane,
    ])));

    const { onOpen } = renderBrowser(vi.fn(), {
      compact: true,
      autoFocusSearch: false,
      initialFolderPath: folderPath,
      selectedPath: `${folderPath}/setup-commands.md`,
    });

    const option = Array.from(container.querySelectorAll('[role="treeitem"]')).find(
      (el) => el.getAttribute("title") === controlPlane.displayPath,
    )!;
    act(() => {
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onOpen).toHaveBeenCalledWith({
      path: `${folderPath}/control-plane-commands.md`,
      workspace: "auto",
      browseFolderPath: folderPath,
      browseQuery: null,
    });
  });

  it("scrolls the selected file into view after breadcrumb-scoped listings", () => {
    const folderPath = "docs";
    const selectedPath = "docs/cli/setup-commands.md";
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: Element) {
      if (this.getAttribute("aria-selected") === "true") {
        return { top: 1086, bottom: 1114, left: 0, right: 100, width: 100, height: 28, x: 0, y: 1086, toJSON: () => ({}) };
      }
      if (typeof this.className === "string" && this.className.includes("overflow-y-auto")) {
        return { top: 188, bottom: 546, left: 0, right: 320, width: 320, height: 358, x: 0, y: 188, toJSON: () => ({}) };
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    });
    useQueryMock.mockReturnValue(ok(availableResponse([createItem({
      title: "setup-commands.md",
      relativePath: selectedPath,
      displayPath: selectedPath,
    })])));

    renderBrowser(vi.fn(), {
      compact: true,
      autoFocusSearch: false,
      initialFolderPath: folderPath,
      selectedPath,
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("lets breadcrumb folders navigate to parent directories", () => {
    const folderPath = "content-os/cases/active/";
    useQueryMock.mockReturnValue(ok(availableResponse([createItem({
      relativePath: `${folderPath}README.md`,
      displayPath: `${folderPath}README.md`,
    })])));

    renderBrowser(vi.fn(), { initialFolderPath: folderPath });
    const contentOsCrumb = Array.from(container.querySelectorAll("button")).find(
      (el) => el.getAttribute("title") === "content-os",
    );
    expect(contentOsCrumb).not.toBeUndefined();
    act(() => {
      contentOsCrumb!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const latestListCall = useQueryMock.mock.calls.filter(([options]) => options.queryKey?.[3] === "list").at(-1);
    expect(latestListCall?.[0].queryKey[4]).toMatchObject({ path: "content-os" });
  });
});

describe("describeUnavailable", () => {
  it("maps reasons to copy that matches the viewer's denial voice", () => {
    expect(describeUnavailable("remote_workspace").title).toBe("Remote workspace preview not supported");
    expect(describeUnavailable("no_workspace").title).toBe("No workspace yet");
    expect(describeUnavailable("no_local_workspace").title).toBe("No workspace yet");
    expect(describeUnavailable("workspace_unavailable").title).toBe("Workspace is no longer available");
    expect(describeUnavailable("archived").title).toBe("Workspace is no longer available");
  });

  it("never leaks the raw reason code as the body", () => {
    for (const reason of ["remote_workspace", "no_workspace", "workspace_unavailable", "weird_unknown"]) {
      const { body } = describeUnavailable(reason);
      expect(body).not.toBe(reason);
      expect(body).not.toMatch(/^[a-z_]+$/);
    }
  });
});
