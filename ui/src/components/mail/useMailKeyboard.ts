import { useEffect } from "react";

export interface MailKeyboardHandlers {
  next: () => void;
  prev: () => void;
  open: () => void;
  compose: () => void;
  reply: () => void;
  replyAll: () => void;
  forward: () => void;
  archive: () => void;
  trash: () => void;
  toggleStar: () => void;
  toggleUnread: () => void;
  focusSearch: () => void;
  escape: () => void;
  help: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Gmail-style keyboard shortcuts for the mail client, scoped to when the Mail
 * tab is active and the user is not typing in a field/editor.
 */
export function useMailKeyboard(enabled: boolean, handlers: MailKeyboardHandlers) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handlers.escape();
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "j":
          e.preventDefault();
          handlers.next();
          break;
        case "k":
          e.preventDefault();
          handlers.prev();
          break;
        case "Enter":
          handlers.open();
          break;
        case "c":
          e.preventDefault();
          handlers.compose();
          break;
        case "r":
          handlers.reply();
          break;
        case "a":
          handlers.replyAll();
          break;
        case "f":
          handlers.forward();
          break;
        case "e":
          handlers.archive();
          break;
        case "#":
          handlers.trash();
          break;
        case "s":
          handlers.toggleStar();
          break;
        case "u":
          handlers.toggleUnread();
          break;
        case "/":
          e.preventDefault();
          handlers.focusSearch();
          break;
        case "?":
          handlers.help();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, handlers]);
}
