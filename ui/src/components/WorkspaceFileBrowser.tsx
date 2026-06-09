import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Cloud, FileCode2, FolderOpen, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fileResourcesApi } from "@/api/file-resources";
import { projectsApi } from "@/api/projects";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { parseWorkspaceFileRef } from "@/lib/workspace-file-parser";
import type {
  Project,
  WorkspaceFileListItem,
  WorkspaceFileListMode,
  WorkspaceFileSelector,
} from "@paperclipai/shared";

type BrowserSource = "current" | "other";

// Hard list cap. The spec called out ~50 to keep reads cheap; 100 trades a bit
// more scan for fewer "refine to narrow" dead-ends on large trees. Footer always
// discloses truncation so the cap is never silent.
const LIST_LIMIT = 100;

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

function normalizeFolderPrefix(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

function parentFolderPath(path: string | null | undefined): string | null {
  const trimmed = path?.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const index = trimmed.lastIndexOf("/");
  return index > 0 ? trimmed.slice(0, index) : null;
}

/**
 * Maps a server `unavailableReason` to a calm, board-readable explanation.
 * Copy is kept in sync with `describeDenial` in FileViewerSheet so the browse
 * states and the viewer's error panels read in one voice. Substring matching
 * keeps it resilient to small reason-string changes on the server.
 */
export function describeUnavailable(reason: string): { title: string; body: string; icon: ReactNode } {
  const lower = reason.toLowerCase();
  if (lower.includes("remote")) {
    return {
      icon: <Cloud aria-hidden="true" className="h-5 w-5 text-muted-foreground" />,
      title: "Remote workspace preview not supported",
      body: "This workspace is hosted remotely and is not available for inline preview yet.",
    };
  }
  if (lower.includes("no_workspace") || lower.includes("no_local")) {
    return {
      icon: <FolderOpen aria-hidden="true" className="h-5 w-5 text-muted-foreground" />,
      title: "No workspace yet",
      body: "This issue does not have a workspace to browse. Files appear here once a run creates one.",
    };
  }
  if (lower.includes("archiv") || lower.includes("cleaned") || lower.includes("unavailable")) {
    return {
      icon: <FolderOpen aria-hidden="true" className="h-5 w-5 text-muted-foreground" />,
      title: "Workspace is no longer available",
      body: "The isolated worktree for this issue has been cleaned up, so files cannot be previewed.",
    };
  }
  return {
    icon: <AlertTriangle aria-hidden="true" className="h-5 w-5 text-amber-500" />,
    title: "Workspace unavailable",
    body: "These workspace files can't be browsed right now.",
  };
}

function StateMessage({ icon, title, body }: { icon: ReactNode; title: string; body?: string }) {
  return (
    <div className="flex items-start gap-3 px-1 py-8 text-sm">
      {icon}
      <div className="space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        {body ? <p className="text-muted-foreground">{body}</p> : null}
      </div>
    </div>
  );
}

function WorkspaceFileBreadcrumbs({
  rootLabel,
  folderPath,
  onOpenFolder,
}: {
  rootLabel: string | null;
  folderPath: string | null;
  onOpenFolder: (path: string | null) => void;
}) {
  const segments = folderPath?.split("/").filter(Boolean) ?? [];
  if (!rootLabel && segments.length === 0) return null;

  return (
    <nav aria-label="Current folder" className="min-w-0 overflow-hidden text-[11px] text-muted-foreground">
      <ol className="flex min-w-0 items-center gap-1 overflow-hidden">
        {rootLabel ? (
          <li className="min-w-0 shrink">
            <button
              type="button"
              onClick={() => onOpenFolder(null)}
              className="max-w-full truncate rounded px-1 py-0.5 text-left hover:bg-accent hover:text-foreground"
              title={rootLabel}
            >
              {rootLabel}
            </button>
          </li>
        ) : null}
        {segments.map((segment, index) => {
          const path = segments.slice(0, index + 1).join("/");
          return (
            <li key={path} className="flex min-w-0 shrink items-center gap-1">
              <span aria-hidden="true" className="shrink-0 opacity-50">/</span>
              <button
                type="button"
                onClick={() => onOpenFolder(path)}
                className="max-w-full truncate rounded px-1 py-0.5 text-left font-mono hover:bg-accent hover:text-foreground"
                title={path}
              >
                {segment}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

interface WorkspaceFileRowProps {
  item: WorkspaceFileListItem;
  treeItemId: string;
  selected: boolean;
  highlighted: boolean;
  depth: number;
  onOpen: () => void;
  onHover: () => void;
}

function WorkspaceFileRow({ item, treeItemId, selected, highlighted, depth, onOpen, onHover }: WorkspaceFileRowProps) {
  const name = basename(item.relativePath);
  return (
    <div
      id={treeItemId}
      role="treeitem"
      aria-selected={selected}
      onClick={onOpen}
      onMouseEnter={onHover}
      title={item.displayPath}
      className={cn(
        "flex min-h-[36px] cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 sm:min-h-0",
        selected ? "bg-accent text-foreground" : highlighted ? "bg-accent/50" : "hover:bg-accent/60",
      )}
      style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}
    >
      <FileCode2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{name}</span>
    </div>
  );
}

interface WorkspaceFileTreeFolderNode {
  kind: "folder";
  key: string;
  name: string;
  depth: number;
  children: WorkspaceFileTreeNode[];
}

interface WorkspaceFileTreeFileNode {
  kind: "file";
  key: string;
  item: WorkspaceFileListItem;
  depth: number;
}

type WorkspaceFileTreeNode = WorkspaceFileTreeFolderNode | WorkspaceFileTreeFileNode;

interface MutableTreeFolder {
  kind: "folder";
  key: string;
  name: string;
  depth: number;
  folders: Map<string, MutableTreeFolder>;
  files: WorkspaceFileTreeFileNode[];
}

function itemKey(item: WorkspaceFileListItem): string {
  return `${item.workspaceId}:${item.relativePath}`;
}

function compareTreeNodes(a: WorkspaceFileTreeNode, b: WorkspaceFileTreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  const aName = a.kind === "folder" ? a.name : basename(a.item.relativePath);
  const bName = b.kind === "folder" ? b.name : basename(b.item.relativePath);
  return aName.localeCompare(bName);
}

function finalizeTreeFolder(folder: MutableTreeFolder): WorkspaceFileTreeFolderNode {
  const children: WorkspaceFileTreeNode[] = [
    ...Array.from(folder.folders.values()).map(finalizeTreeFolder),
    ...folder.files,
  ];
  children.sort(compareTreeNodes);
  return {
    kind: "folder",
    key: folder.key,
    name: folder.name,
    depth: folder.depth,
    children,
  };
}

function buildWorkspaceFileTree(items: WorkspaceFileListItem[], rootPath: string | null | undefined) {
  const rootPrefix = normalizeFolderPrefix(rootPath);
  const root: MutableTreeFolder = {
    kind: "folder",
    key: "__root__",
    name: "",
    depth: -1,
    folders: new Map(),
    files: [],
  };

  for (const item of items) {
    const path = item.relativePath.startsWith(rootPrefix)
      ? item.relativePath.slice(rootPrefix.length)
      : item.relativePath;
    const segments = path.split("/").filter(Boolean);
    const fileName = segments.pop() ?? basename(item.relativePath);
    let cursor = root;
    let currentPath = rootPrefix.replace(/\/$/, "");
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let folder = cursor.folders.get(segment);
      if (!folder) {
        folder = {
          kind: "folder",
          key: currentPath,
          name: segment,
          depth: cursor.depth + 1,
          folders: new Map(),
          files: [],
        };
        cursor.folders.set(segment, folder);
      }
      cursor = folder;
    }
    cursor.files.push({
      kind: "file",
      key: itemKey(item),
      item: { ...item, title: fileName },
      depth: cursor.depth + 1,
    });
  }

  const tree = finalizeTreeFolder(root);
  return tree.children;
}

interface WorkspaceFileTreeProps {
  nodes: WorkspaceFileTreeNode[];
  listboxId: string;
  highlightedItemKey: string | null;
  selectedItemKey: string | null;
  collapsedFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  onOpen: (item: WorkspaceFileListItem) => void;
  onHoverFile: (item: WorkspaceFileListItem) => void;
}

function WorkspaceFileTree({
  nodes,
  listboxId,
  highlightedItemKey,
  selectedItemKey,
  collapsedFolders,
  onToggleFolder,
  onOpen,
  onHoverFile,
}: WorkspaceFileTreeProps) {
  function renderNode(node: WorkspaceFileTreeNode): ReactNode {
    if (node.kind === "folder") {
      const expanded = !collapsedFolders.has(node.key);
      return (
        <div key={node.key}>
          <button
            type="button"
            role="treeitem"
            aria-expanded={expanded}
            title={node.key}
            onClick={() => onToggleFolder(node.key)}
            className="flex min-h-[32px] w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-accent/60"
            style={{ paddingLeft: `${0.25 + node.depth * 0.875}rem` }}
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{node.name}</span>
          </button>
          {expanded ? node.children.map(renderNode) : null}
        </div>
      );
    }

    return (
      <WorkspaceFileRow
        key={node.key}
        item={node.item}
        treeItemId={`${listboxId}-file-${node.key}`}
        selected={node.key === selectedItemKey}
        highlighted={node.key === highlightedItemKey}
        depth={node.depth}
        onOpen={() => onOpen(node.item)}
        onHover={() => onHoverFile(node.item)}
      />
    );
  }

  return (
    <div role="tree" id={listboxId} aria-label="Workspace files" className="space-y-0.5 py-1">
      {nodes.map(renderNode)}
    </div>
  );
}

export interface WorkspaceFileBrowserProps {
  issueId: string;
  companyId?: string | null;
  onOpen: (ref: {
    path: string;
    workspace: WorkspaceFileSelector;
    line?: number | null;
    column?: number | null;
    projectId?: string | null;
    workspaceId?: string | null;
    browseFolderPath?: string | null;
    browseQuery?: string | null;
  }) => void;
  onBrowseStateChange?: (state: {
    q: string | null;
    folderPath: string | null;
    projectId: string | null;
    workspaceId: string | null;
  }) => void;
  /** Seed the search field (e.g. from a URL-backed deep link). */
  initialQuery?: string | null;
  initialFolderPath?: string | null;
  initialProjectId?: string | null;
  initialWorkspaceId?: string | null;
  autoFocusSearch?: boolean;
  compact?: boolean;
  selectedPath?: string | null;
  selectedProjectId?: string | null;
  selectedWorkspaceId?: string | null;
  className?: string;
}

export function WorkspaceFileBrowser({
  issueId,
  companyId,
  onOpen,
  onBrowseStateChange,
  initialQuery,
  initialFolderPath,
  initialProjectId,
  initialWorkspaceId,
  autoFocusSearch = true,
  selectedPath,
  selectedProjectId: activeProjectId,
  selectedWorkspaceId: activeWorkspaceId,
  className,
}: WorkspaceFileBrowserProps) {
  const source: BrowserSource =
    initialProjectId && initialWorkspaceId ? "other" : "current";
  const workspace: WorkspaceFileSelector = "auto";
  const selectedParentPath = useMemo(() => parentFolderPath(selectedPath), [selectedPath]);
  const effectiveInitialFolderPath = useMemo(() => {
    if (typeof initialFolderPath !== "undefined") return initialFolderPath;
    return initialQuery?.trim() ? null : selectedParentPath;
  }, [initialFolderPath, initialQuery, selectedParentPath]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProjectId ?? null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(initialWorkspaceId ?? null);
  const [folderPath, setFolderPath] = useState<string | null>(effectiveInitialFolderPath ?? null);
  const [searchInput, setSearchInput] = useState(initialQuery ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery?.trim() ?? "");
  // When the workspace has no git change-tracking we silently fall back to a full
  // listing for the default (empty-query) view, per spec.
  const [recentUnavailable, setRecentUnavailable] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());

  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const projectsQuery = useQuery({
    queryKey: companyId ? queryKeys.projects.list(companyId) : ["projects", "__none__"],
    queryFn: () => projectsApi.list(companyId!),
    enabled: source === "other" && !!companyId,
    retry: false,
    staleTime: 30_000,
  });

  const projectRows = useMemo(
    () => Array.isArray(projectsQuery.data) ? projectsQuery.data : [],
    [projectsQuery.data],
  );
  const projectsWithWorkspaces = useMemo(
    () => projectRows.filter((project: Project) => project.workspaces.length > 0),
    [projectRows],
  );
  const selectedProject = useMemo(
    () => projectsWithWorkspaces.find((project) => project.id === selectedProjectId) ?? null,
    [projectsWithWorkspaces, selectedProjectId],
  );
  const selectedWorkspace = useMemo(
    () => selectedProject?.workspaces.find((item) => item.id === selectedWorkspaceId) ?? null,
    [selectedProject, selectedWorkspaceId],
  );

  useEffect(() => {
    if (source !== "other" || !projectsQuery.data) return;
    const nextProject = selectedProject ?? projectsWithWorkspaces[0] ?? null;
    if (!nextProject) {
      setSelectedProjectId(null);
      setSelectedWorkspaceId(null);
      return;
    }
    if (selectedProjectId !== nextProject.id) {
      setSelectedProjectId(nextProject.id);
    }
    const nextWorkspace = nextProject.workspaces.find((item) => item.id === selectedWorkspaceId)
      ?? nextProject.primaryWorkspace
      ?? nextProject.workspaces[0]
      ?? null;
    setSelectedWorkspaceId(nextWorkspace?.id ?? null);
  }, [projectsQuery.data, projectsWithWorkspaces, selectedProject, selectedProjectId, selectedWorkspaceId, source]);

  useEffect(() => {
    setSelectedProjectId(initialProjectId ?? null);
    setSelectedWorkspaceId(initialWorkspaceId ?? null);
  }, [initialProjectId, initialWorkspaceId]);

  useEffect(() => {
    setFolderPath(effectiveInitialFolderPath ?? null);
    setSearchInput(initialQuery ?? "");
    setDebouncedQuery(initialQuery?.trim() ?? "");
  }, [effectiveInitialFolderPath, initialQuery]);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(searchInput.trim()), 150);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  // A new search or workspace should re-attempt recent-change tracking.
  useEffect(() => {
    setRecentUnavailable(false);
  }, [workspace, source, selectedProjectId, selectedWorkspaceId, folderPath]);

  const q = debouncedQuery || null;
  const isSearch = q !== null;
  const mode: WorkspaceFileListMode = folderPath || isSearch || selectedPath ? "all" : recentUnavailable ? "all" : "changed";
  const targetProjectId = source === "other" ? selectedProjectId : null;
  const targetWorkspaceId = source === "other" ? selectedWorkspaceId : null;
  const effectiveWorkspace: WorkspaceFileSelector = source === "other" ? "project" : workspace;
  const canListFiles = source === "current" || Boolean(targetProjectId && targetWorkspaceId);
  const targetRef = targetProjectId && targetWorkspaceId
    ? { projectId: targetProjectId, workspaceId: targetWorkspaceId }
    : {};

  useEffect(() => {
    onBrowseStateChange?.({
      q: searchInput.trim() || null,
      folderPath,
      projectId: targetProjectId,
      workspaceId: targetWorkspaceId,
    });
  }, [folderPath, onBrowseStateChange, searchInput, targetProjectId, targetWorkspaceId]);

  const listQuery = useQuery({
    queryKey: queryKeys.issues.fileResources(issueId, {
      workspace: effectiveWorkspace,
      projectId: targetProjectId,
      workspaceId: targetWorkspaceId,
      mode,
      q,
      limit: LIST_LIMIT,
      path: folderPath,
    }),
    queryFn: () => fileResourcesApi.list(issueId, {
      workspace: effectiveWorkspace,
      projectId: targetProjectId,
      workspaceId: targetWorkspaceId,
      mode,
      q,
      limit: LIST_LIMIT,
      path: folderPath,
    }),
    enabled: canListFiles,
    retry: false,
    staleTime: 15_000,
  });

  const data = listQuery.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const workspaceLabel = data?.workspace?.workspaceLabel ?? null;
  const treeNodes = useMemo(() => buildWorkspaceFileTree(items, folderPath), [folderPath, items]);
  const selectedItemIndex = selectedPath
    ? items.findIndex((item) =>
      item.relativePath === selectedPath &&
      (activeProjectId ? item.projectId === activeProjectId : true) &&
      (activeWorkspaceId ? item.workspaceId === activeWorkspaceId : true)
    )
    : -1;

  // Silent fallback: empty-query view with no change-tracking → list everything.
  useEffect(() => {
    if (!isSearch && data?.state === "unavailable" && (data.unavailableReason ?? "").toLowerCase().includes("changed")) {
      setRecentUnavailable(true);
    }
  }, [data, isSearch]);

  // Keep the highlighted option valid as results change.
  useEffect(() => {
    if (selectedPath) {
      setHighlightedIndex(selectedItemIndex >= 0 ? selectedItemIndex : -1);
      return;
    }
    setHighlightedIndex(items.length > 0 ? 0 : -1);
  }, [items.length, q, workspace, source, selectedProjectId, selectedWorkspaceId, folderPath, selectedPath, selectedItemIndex]);

  const announcement = useMemo(() => {
    if (listQuery.isFetching) return "Loading workspace files…";
    if (listQuery.isError) return "Unable to load workspace files.";
    if (data?.state === "unavailable") return describeUnavailable(data.unavailableReason ?? "").title;
    if (items.length === 0) return "No matching files.";
    return `${items.length} file${items.length === 1 ? "" : "s"} found.`;
  }, [data, items.length, listQuery.isError, listQuery.isFetching]);

  function openTypedPath() {
    const value = searchInput.trim();
    if (!value) return;
    const parsed = parseWorkspaceFileRef(value);
    const target = { workspace: effectiveWorkspace, ...targetRef };
    if (parsed?.resourceKind === "directory") {
      setFolderPath(parsed.path);
      setSearchInput("");
      setDebouncedQuery("");
    } else if (parsed) {
      onOpen({
        path: parsed.path,
        ...target,
        line: parsed.line,
        column: parsed.column,
        browseFolderPath: folderPath,
        browseQuery: searchInput.trim() || null,
      });
    } else {
      onOpen({
        path: value,
        ...target,
        browseFolderPath: folderPath,
        browseQuery: searchInput.trim() || null,
      });
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) => (items.length === 0 ? -1 : Math.min(items.length - 1, current + 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => (items.length === 0 ? -1 : Math.max(0, current - 1)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = highlightedIndex >= 0 ? items[highlightedIndex] : undefined;
      if (item) {
        const itemTarget = item.projectId
          ? { projectId: item.projectId, workspaceId: item.workspaceId }
          : targetRef;
        onOpen({
          path: item.relativePath,
          workspace: effectiveWorkspace,
          ...itemTarget,
          browseFolderPath: folderPath,
          browseQuery: searchInput.trim() || null,
        });
      }
      else openTypedPath();
    }
  }

  const highlightedItem = highlightedIndex >= 0 ? items[highlightedIndex] : undefined;
  const highlightedItemKey = highlightedItem ? itemKey(highlightedItem) : null;
  const selectedItem = selectedItemIndex >= 0 ? items[selectedItemIndex] : null;
  const selectedItemKey = selectedItem ? itemKey(selectedItem) : null;
  const selectedOptionId = selectedItemKey ? `${listboxId}-file-${selectedItemKey}` : null;
  const activeOptionId = highlightedItemKey ? `${listboxId}-file-${highlightedItemKey}` : undefined;

  useEffect(() => {
    if (!selectedOptionId) return;
    const scrollContainer = scrollContainerRef.current;
    const selectedElement = document.getElementById(selectedOptionId);
    if (!scrollContainer || !selectedElement) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    const selectedRect = selectedElement.getBoundingClientRect();
    if (selectedRect.top < containerRect.top || selectedRect.bottom > containerRect.bottom) {
      selectedElement.scrollIntoView({ block: "nearest" });
    }
  }, [folderPath, items, selectedOptionId]);

  function openFolder(path: string | null) {
    setFolderPath(path);
    setSearchInput("");
    setDebouncedQuery("");
  }

  function openItem(item: WorkspaceFileListItem) {
    const itemTarget = item.projectId
      ? { projectId: item.projectId, workspaceId: item.workspaceId }
      : targetRef;
    onOpen({
      path: item.relativePath,
      workspace: effectiveWorkspace,
      ...itemTarget,
      browseFolderPath: folderPath,
      browseQuery: searchInput.trim() || null,
    });
  }

  function toggleFolder(key: string) {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleHoverFile(item: WorkspaceFileListItem) {
    const key = itemKey(item);
    const index = items.findIndex((candidate) => itemKey(candidate) === key);
    if (index >= 0) setHighlightedIndex(index);
  }

  let body: ReactNode;
  if (source === "other" && !companyId) {
    body = (
      <StateMessage
        icon={<FolderOpen aria-hidden="true" className="h-5 w-5 text-muted-foreground" />}
        title="No company selected"
        body="Choose a company before browsing another project workspace."
      />
    );
  } else if (source === "other" && projectsQuery.isFetching && projectsWithWorkspaces.length === 0) {
    body = (
      <StateMessage
        icon={<Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-muted-foreground" />}
        title="Loading project workspaces"
        body="Registered workspaces will appear here."
      />
    );
  } else if (source === "other" && !canListFiles) {
    body = (
      <StateMessage
        icon={<FolderOpen aria-hidden="true" className="h-5 w-5 text-muted-foreground" />}
        title="No project workspaces"
        body="No same-company project has a registered workspace to browse."
      />
    );
  } else if (listQuery.isFetching && !data) {
    body = (
      <div className="space-y-1.5 py-2" aria-busy="true">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="flex items-center gap-2 px-2 py-1.5">
            <div className="h-3.5 w-3.5 shrink-0 rounded bg-muted" />
            <div className="h-3 flex-1 rounded bg-muted" style={{ maxWidth: `${80 - index * 8}%` }} />
          </div>
        ))}
      </div>
    );
  } else if (listQuery.isError) {
    const status = listQuery.error instanceof ApiError ? listQuery.error.status : 0;
    body = (
      <StateMessage
        icon={<AlertTriangle aria-hidden="true" className="h-5 w-5 text-amber-500" />}
        title="Couldn't load files"
        body={
          status === 404
            ? "Workspace browsing isn't available for this issue."
            : "Something went wrong loading workspace files."
        }
      />
    );
  } else if (data?.state === "unavailable") {
    const detail = describeUnavailable(data.unavailableReason ?? "");
    body = <StateMessage icon={detail.icon} title={detail.title} body={detail.body} />;
  } else if (items.length === 0) {
    body = (
      <StateMessage
        icon={<Search aria-hidden="true" className="h-5 w-5 text-muted-foreground" />}
        title={isSearch ? `No files match “${q}”` : "No recently changed files yet"}
        body="Try searching by name or path."
      />
    );
  } else {
    body = (
      <WorkspaceFileTree
        nodes={treeNodes}
        listboxId={listboxId}
        highlightedItemKey={highlightedItemKey}
        selectedItemKey={selectedItemKey}
        collapsedFolders={collapsedFolders}
        onToggleFolder={toggleFolder}
        onOpen={openItem}
        onHoverFile={handleHoverFile}
      />
    );
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col gap-2", className)}>
      <div className="relative min-w-0 max-w-full overflow-hidden">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search files by name or path…"
          aria-label="Search workspace files"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={items.length > 0 ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          autoFocus={autoFocusSearch}
          autoComplete="off"
          spellCheck={false}
          className="h-8 w-full max-w-full min-w-0 pl-8 font-mono text-xs"
        />
      </div>

      <WorkspaceFileBreadcrumbs
        rootLabel={selectedProject && selectedWorkspace ? `${selectedProject.name} / ${selectedWorkspace.name}` : workspaceLabel}
        folderPath={folderPath}
        onOpenFolder={openFolder}
      />

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">{body}</div>

      {data?.truncated ? (
        <div className="border-t border-border pt-2 text-[11px] text-muted-foreground">
          Showing first {items.length} — refine the search to narrow.
        </div>
      ) : null}
    </div>
  );
}
