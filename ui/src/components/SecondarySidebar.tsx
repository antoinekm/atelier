import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Fixed-width contextual pane that sits between the collapsed app rail and the
 * main content on takeover routes (company settings, plugin `routeSidebar`).
 *
 * The takeover model (PAP-10695) no longer *replaces* the app `<Sidebar/>`:
 * the host collapses it to its 64px rail (still peek-able) and renders the
 * contextual sidebar here, yielding `[ rail 64px ][ secondary ~240px ][ content ]`.
 *
 * It is a dumb container — fixed `w-60`, full-height, non-shrinking, with a
 * right border and its own vertical scroll — so callers just drop the
 * contextual nav (or a plugin slot mount) inside as `children`.
 */
export function SecondarySidebar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-secondary-sidebar=""
      className={cn(
        "h-full w-60 shrink-0 overflow-y-auto border-r border-border bg-background",
        className,
      )}
    >
      {children}
    </div>
  );
}
