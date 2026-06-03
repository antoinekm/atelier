import { Folder } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Reusable project tile (IA Phase 3 — PAP-58).
 *
 * Default render is a neutral gray rounded rectangle with a folder icon.
 * An optional `color` tints the background; the folder icon is fixed for all
 * tiles this phase (custom-icon picker is deferred to a later phase).
 *
 * Used by the Projects list rows and the project detail header. The color
 * lives on the project itself (`project.color`) — no new `project.icon` field.
 */

export type ProjectTileSize = "xs" | "sm" | "md" | "lg";

const SIZE_STYLES: Record<ProjectTileSize, { box: string; icon: string }> = {
  xs: { box: "h-4 w-4 rounded-sm", icon: "h-2.5 w-2.5" },
  sm: { box: "h-6 w-6 rounded-md", icon: "h-3.5 w-3.5" },
  md: { box: "h-7 w-7 rounded-lg", icon: "h-4 w-4" },
  lg: { box: "h-9 w-9 rounded-lg", icon: "h-5 w-5" },
};

export interface ProjectTileProps {
  /** Optional project color. When unset, the tile stays neutral gray. */
  color?: string | null;
  size?: ProjectTileSize;
  className?: string;
}

export function ProjectTile({ color, size = "md", className }: ProjectTileProps) {
  const dims = SIZE_STYLES[size];
  const tinted = Boolean(color);

  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        dims.box,
        tinted ? "text-white" : "bg-muted text-muted-foreground",
        className,
      )}
      style={tinted ? { backgroundColor: color ?? undefined } : undefined}
    >
      <Folder className={dims.icon} />
    </span>
  );
}
