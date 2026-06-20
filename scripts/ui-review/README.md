# UI Review Recipe — headless render + token→WCAG resolver

A **role-agnostic**, copy-pasteable recipe for rendering Paperclip UI in a
no-sudo sandbox and resolving design tokens to computed colors + WCAG verdicts.
Either **UXDesigner** or **QA** can run this to close render-dependent review
items (contrast, focus-ring visibility, mobile 390×844, long-thread scroll) in a
**single pass** — one verdict in one heartbeat — instead of a UX→QA two-ticket
handoff.

This documents the **existing** headless-render flow on top of the shared
Chromium provisioner. It does not re-architect provisioning.

> When to use which: render the surface for visual/interaction craft (this
> recipe, part 1); resolve a token or check a contrast ratio numerically without
> a full render (the resolver CLI, part 2). Most contrast verdicts only need
> part 2.

---

## TL;DR

```bash
# repo root
PREFIX="$HOME/.cache/pw-chromium-deps"

# 1. one-time per sandbox: provision userspace Chromium host libs (no sudo)
bash scripts/qa/provision-headless-chromium.sh "$PREFIX"
source "$PREFIX/pw-chromium-env.sh"

# 2. build the static Storybook (renders every component story to a static site)
pnpm build-storybook            # -> ui/storybook-static/

# 3. drive Playwright over the stories (see render-stories.mjs example below)
node /tmp/render-stories.mjs    # writes screenshots to /tmp/ui-review/

# 4. resolve tokens / check contrast numerically (no render needed)
node scripts/ui-review/resolve-token.mjs contrast muted-foreground background
```

---

## Part 1 — Headless render

### Step 1: Provision Chromium host libs (no sudo)

The sandbox has Playwright's bundled Chromium but is missing the host shared
libraries (libatk, libcups, libgbm, …) and has no root. The provisioner
downloads + extracts them into a userspace prefix and emits an env file.

```bash
PREFIX="$HOME/.cache/pw-chromium-deps"
bash scripts/qa/provision-headless-chromium.sh "$PREFIX"
source "$PREFIX/pw-chromium-env.sh"   # sets LD_LIBRARY_PATH + fontconfig
```

Run the `source` line in **every** shell that launches Chromium. Details +
maintenance notes are in `scripts/qa/provision-headless-chromium.sh`.

### Step 2: Build the static Storybook

```bash
pnpm build-storybook              # alias for: pnpm --filter @paperclipai/ui build-storybook
# output: ui/storybook-static/
```

The static build renders each story at `iframe.html?id=<storyId>` and emits a
manifest at `ui/storybook-static/index.json`.

### Step 3: Resolve story ids from `index.json`

Story ids are **not** guessable from the component name — read them from the
manifest:

```bash
# list all story ids
node -e "const m=require('./ui/storybook-static/index.json');for(const e of Object.values(m.entries))if(e.type==='story')console.log(e.id, '::', e.title, '>', e.name)"
```

Each entry's `id` (e.g. `components-button--primary`) is what you load via
`iframe.html?id=<id>`.

### Step 4: Drive Playwright (screenshot / evaluate)

Tribal-knowledge mechanics, all captured here:

- **ESM, absolute-path import.** The script is `.mjs` and imports Playwright by
  its **absolute** path in `node_modules` (the sandbox resolver does not always
  find it relatively). Because the path is built from `process.cwd()` at
  runtime, use a **dynamic** import (a static `import` cannot take a computed
  specifier):
  `const { chromium } = await import(\`${process.cwd()}/node_modules/playwright-core/index.js\`)`
  (or `@playwright/test`).
- **Load stories from the static build over `file://`** —
  `file://<repoRoot>/ui/storybook-static/iframe.html?id=<storyId>`. No dev
  server needed.
- **Dark mode is a `class` toggle**, not a query param. Set it on the iframe's
  document root before screenshotting:
  `document.documentElement.classList.add('dark')`.
- **Viewport conventions:** desktop **1440×900**, mobile **390×844** — the
  standard pair used by the UXDesigner Visual-truth gate.

Example `render-stories.mjs` (write to `/tmp`, adjust the `STORY_IDS`):

```js
// /tmp/render-stories.mjs   —   run: node /tmp/render-stories.mjs
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
// Dynamic import so the absolute node_modules path is resolved at runtime
// (a static `import` cannot take a computed/template-literal specifier).
const { chromium } = await import(`${ROOT}/node_modules/playwright-core/index.js`);

const OUT = '/tmp/ui-review';
mkdirSync(OUT, { recursive: true });

const STORY_IDS = ['components-button--primary']; // from index.json
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const THEMES = ['light', 'dark'];

const browser = await chromium.launch(); // headless by default
for (const id of STORY_IDS) {
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    for (const theme of THEMES) {
      const page = await browser.newPage({ viewport: vp });
      await page.goto(`file://${ROOT}/ui/storybook-static/iframe.html?id=${id}`);
      await page.waitForSelector('#storybook-root');
      await page.evaluate((t) => {
        document.documentElement.classList.toggle('dark', t === 'dark');
      }, theme);
      // optional numeric pull: computed color of an element
      // const color = await page.evaluate(() => getComputedStyle(document.querySelector('button')).color);
      await page.screenshot({ path: `${OUT}/${id}__${vpName}__${theme}.png` });
      await page.close();
    }
  }
}
await browser.close();
console.log(`screenshots -> ${OUT}`);
```

`page.evaluate(() => getComputedStyle(el).color)` gives you the **rendered**
color of any element — useful when a token is composed at runtime and you want
ground truth rather than the static CSS value.

---

## Part 2 — token → computed value + WCAG resolver

`scripts/ui-review/resolve-token.mjs` resolves a design token to its computed
hex from the source-of-truth tokens (`ui/src/index.css`) and computes the WCAG
contrast ratio + AA/AAA verdict for a pair. No render or browser required — pure
Node, zero dependencies.

```bash
# resolve a single token (light theme by default)
node scripts/ui-review/resolve-token.mjs muted-foreground
node scripts/ui-review/resolve-token.mjs colors.foreground --theme dark

# contrast for a token pair (fg vs bg)
node scripts/ui-review/resolve-token.mjs contrast muted-foreground background

# token vs a literal color
node scripts/ui-review/resolve-token.mjs contrast foreground "#fafafa" --theme dark

# self-check the color math (one known pair: black/white == 21:1)
node scripts/ui-review/resolve-token.mjs --selfcheck

# machine-readable
node scripts/ui-review/resolve-token.mjs contrast muted-foreground background --json
```

**Token name forms accepted:** `--muted-foreground`, `muted-foreground`, or
`colors.muted-foreground` (a leading `color`/`colors.` segment is dropped and
dots become dashes). **Color literals accepted:** `#hex`, `rgb()`, `hsl()`,
`oklch()`, `oklab()`.

**WCAG thresholds reported:** AA normal ≥ 4.5, AA large ≥ 3.0, AAA normal ≥ 7.0,
AAA large ≥ 4.5.

Sample run:

```
$ node scripts/ui-review/resolve-token.mjs contrast muted-foreground background
theme:      light
fg:         muted-foreground  ->  #737373  (oklch(0.556 0 0))
bg:         background  ->  #ffffff  (oklch(1 0 0))
ratio:      4.74:1
AA  normal (>=4.5): PASS
AA  large  (>=3.0): PASS
AAA normal (>=7.0): FAIL
AAA large  (>=4.5): PASS
```

The contrast math is a formalized WCAG ratio calculation; `--selfcheck` proves
it against the canonical black/white = 21:1 pair (plus oklch round-trips).

---

## For reviewers (UXDesigner / QA)

- **Single-pass is the default.** Render-dependent items — contrast, focus-ring
  visibility, mobile 390×844, long-thread scroll — should be closed inline using
  this recipe + resolver and a cited rendered viewport.
- **QA handoff is the fallback only** when a surface is genuinely unrenderable
  (auth-gated / sandbox-denied) — not the default for render-dependent checks.
