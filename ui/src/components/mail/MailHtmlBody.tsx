import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Button } from "@/components/ui/button";

/**
 * Render an untrusted HTML email body safely:
 * - DOMPurify strips scripts, event handlers and dangerous tags.
 * - It is shown inside a sandboxed iframe with a strict CSP, so even if a
 *   sanitizer bypass slipped through, no script can run (the sandbox grants
 *   `allow-same-origin` only, never `allow-scripts`, purely so the parent can
 *   measure the content height).
 * - Remote images are blocked by default (tracking pixels) behind a toggle.
 */
export function MailHtmlBody({ html }: { html: string }) {
  const [showImages, setShowImages] = useState(false);
  const [height, setHeight] = useState(120);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const { srcDoc, blockedImages } = useMemo(() => {
    const clean = DOMPurify.sanitize(html, {
      FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "link", "meta", "base"],
      FORBID_ATTR: ["srcset", "ping"],
      ALLOW_DATA_ATTR: false,
    });
    const doc = new DOMParser().parseFromString(clean, "text/html");
    let blocked = 0;
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      const isRemote = /^https?:/i.test(src);
      if (isRemote && !showImages) {
        img.removeAttribute("src");
        img.setAttribute("data-blocked", "1");
        blocked += 1;
      }
    }
    for (const a of Array.from(doc.querySelectorAll("a"))) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer nofollow");
    }
    const csp = showImages
      ? "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src data:"
      : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
    const body = doc.body.innerHTML;
    return {
      blockedImages: blocked,
      srcDoc: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>html,body{margin:0;padding:0;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.5;color:#0a0a0a;word-break:break-word}img{max-width:100%;height:auto}a{color:#2563eb}</style></head><body>${body}</body></html>`,
    };
  }, [html, showImages]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      try {
        const h = frame.contentDocument?.body?.scrollHeight;
        if (h && h > 0) setHeight(Math.min(h + 8, 4000));
      } catch {
        /* opaque document, keep default */
      }
    };
    frame.addEventListener("load", measure);
    return () => frame.removeEventListener("load", measure);
  }, [srcDoc]);

  return (
    <div className="flex flex-col gap-2">
      {blockedImages > 0 && (
        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">
            {blockedImages} remote image{blockedImages === 1 ? "" : "s"} blocked for your privacy.
          </span>
          <Button size="sm" variant="outline" onClick={() => setShowImages(true)}>
            Show images
          </Button>
        </div>
      )}
      <iframe
        ref={frameRef}
        title="Email body"
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        className="w-full rounded-md border bg-white"
        style={{ height }}
      />
    </div>
  );
}
