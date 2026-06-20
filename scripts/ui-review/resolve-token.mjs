#!/usr/bin/env node
//
// resolve-token.mjs
//
// Resolve a Paperclip design token to its computed color, and compute WCAG
// contrast ratios for a token/literal pair. Closes the UXDesigner blocker
// "I can read `--muted-foreground` but can't resolve its hex" so contrast can
// be checked inline during a single-pass UI review (see scripts/ui-review/README.md).
//
// Source of truth: ui/src/index.css custom properties (`:root` = light theme,
// `.dark` = dark theme). The WCAG math is the formalized version of the
// reviewer contrast calculation.
//
// Usage:
//   node scripts/ui-review/resolve-token.mjs <token> [--theme light|dark]
//   node scripts/ui-review/resolve-token.mjs contrast <fg> <bg> [--theme light|dark]
//   node scripts/ui-review/resolve-token.mjs --selfcheck
//   node scripts/ui-review/resolve-token.mjs --help
//
//   <token> accepts:  --muted-foreground | muted-foreground | colors.muted-foreground
//   <fg>/<bg> accept: a token name (as above) OR a literal color
//                     (#hex, rgb(...), hsl(...), oklch(...), oklab(...)).
//
// Flags:
//   --theme light|dark   Theme scope to resolve tokens in (default: light).
//   --css <path>         Override the tokens file (default: ui/src/index.css).
//   --json               Emit machine-readable JSON instead of a text report.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSS = resolvePath(__dirname, '../../ui/src/index.css');

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// sRGB gamma channel (0..1) -> linear-light (0..1). The WCAG 2.x transfer fn.
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// linear-light (0..1) -> sRGB gamma channel (0..1).
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp01(v);
}

// oklch(L C H) -> {r,g,b} in 0..255. L in 0..1, C >= 0, H in degrees.
// Björn Ottosson's oklab -> linear sRGB matrix.
function oklchToRgb(L, C, H) {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return {
    r: Math.round(linearToSrgb(lr) * 255),
    g: Math.round(linearToSrgb(lg) * 255),
    b: Math.round(linearToSrgb(lb) * 255),
  };
}

// hsl(H S% L%) -> {r,g,b} 0..255.
function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const f = (n) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
}

// Parse a CSS color literal into {r,g,b} 0..255. Supports hex, rgb(), hsl(),
// oklch(), oklab(). Returns null if unrecognized.
function parseColor(value) {
  const v = value.trim();

  // #rgb / #rgba / #rrggbb / #rrggbbaa
  const hex = v.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h.split('').map((c) => c + c).join('');
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  // function-style: name(a b c) or name(a, b, c), optional /alpha
  const fn = v.match(/^(rgba?|hsla?|oklch|oklab)\(([^)]+)\)$/i);
  if (fn) {
    const name = fn[1].toLowerCase();
    const parts = fn[2]
      .replace(/\//g, ' ') // drop alpha separator; we ignore alpha for contrast
      .split(/[\s,]+/)
      .filter(Boolean);
    const num = (t) => parseFloat(t);

    if (name === 'rgb' || name === 'rgba') {
      return { r: Math.round(num(parts[0])), g: Math.round(num(parts[1])), b: Math.round(num(parts[2])) };
    }
    if (name === 'hsl' || name === 'hsla') {
      return hslToRgb(num(parts[0]), num(parts[1]), num(parts[2]));
    }
    if (name === 'oklch') {
      // L may be given as 0..1 or as a percentage.
      let L = num(parts[0]);
      if (parts[0].includes('%')) L /= 100;
      return oklchToRgb(L, num(parts[1]), num(parts[2] ?? '0'));
    }
    if (name === 'oklab') {
      // convert oklab a,b to chroma/hue then reuse oklchToRgb
      let L = num(parts[0]);
      if (parts[0].includes('%')) L /= 100;
      const a = num(parts[1]);
      const b = num(parts[2]);
      const C = Math.hypot(a, b);
      const H = (Math.atan2(b, a) * 180) / Math.PI;
      return oklchToRgb(L, C, H);
    }
  }
  return null;
}

const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');

// WCAG relative luminance from {r,g,b} 0..255.
function relativeLuminance({ r, g, b }) {
  const R = srgbToLinear(r / 255);
  const G = srgbToLinear(g / 255);
  const B = srgbToLinear(b / 255);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

// WCAG contrast ratio between two colors (order-independent), 1..21.
function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function wcagVerdict(ratio) {
  return {
    ratio: Math.round(ratio * 100) / 100,
    AA_normal: ratio >= 4.5,
    AA_large: ratio >= 3,
    AAA_normal: ratio >= 7,
    AAA_large: ratio >= 4.5,
  };
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

// Extract `--name: value;` declarations inside the first block matching the
// given selector (e.g. ":root" or ".dark"). Naive but sufficient for our
// flat token file.
function extractDeclarations(css, selector) {
  // escape selector for regex
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(sel + '\\s*\\{([^}]*)\\}', 'g');
  const map = new Map();
  let m;
  while ((m = re.exec(css)) !== null) {
    const body = m[1];
    const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let d;
    while ((d = declRe.exec(body)) !== null) {
      map.set(d[1].trim(), d[2].trim());
    }
  }
  return map;
}

function buildThemeMap(css, theme) {
  const light = extractDeclarations(css, ':root');
  if (theme === 'dark') {
    const dark = extractDeclarations(css, '.dark');
    return new Map([...light, ...dark]); // dark overrides light
  }
  return light;
}

// Normalize a user-supplied token name to a `--custom-property` key.
//   --muted-foreground -> --muted-foreground
//   muted-foreground   -> --muted-foreground
//   colors.neutral.700 -> --neutral-700   (drops a leading color/colors segment)
function normalizeTokenName(name) {
  let n = name.trim();
  if (n.startsWith('--')) return n;
  if (n.includes('.')) {
    const segs = n.split('.').filter(Boolean);
    if (['color', 'colors'].includes(segs[0].toLowerCase())) segs.shift();
    n = segs.join('-');
  }
  return '--' + n.replace(/^-+/, '');
}

// Resolve a token to its final CSS color value, following var() chains.
function resolveTokenValue(themeMap, tokenKey, seen = new Set()) {
  if (seen.has(tokenKey)) throw new Error(`circular var() reference at ${tokenKey}`);
  seen.add(tokenKey);
  const raw = themeMap.get(tokenKey);
  if (raw === undefined) return null;
  const varMatch = raw.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (varMatch) {
    const next = resolveTokenValue(themeMap, varMatch[1], seen);
    if (next !== null) return next;
    if (varMatch[2]) return varMatch[2].trim(); // var() fallback
    return null;
  }
  return raw;
}

// Resolve either a token name or a literal color string -> {hex, rgb, source}.
function resolveColorArg(arg, themeMap) {
  const literal = parseColor(arg);
  if (literal) {
    return { hex: toHex(literal), rgb: literal, source: arg, kind: 'literal' };
  }
  const key = normalizeTokenName(arg);
  const value = resolveTokenValue(themeMap, key);
  if (value === null) {
    throw new Error(`could not resolve token "${arg}" (looked up ${key})`);
  }
  const rgb = parseColor(value);
  if (!rgb) {
    throw new Error(`token "${arg}" -> "${value}" is not a parseable color`);
  }
  return { hex: toHex(rgb), rgb, source: value, kind: 'token', key };
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

function selfCheck() {
  const cases = [];
  const approx = (a, b, eps) => Math.abs(a - b) <= eps;

  // 1. Known WCAG ratio: pure black vs pure white = 21:1.
  const bw = contrastRatio(parseColor('#000000'), parseColor('#ffffff'));
  cases.push({ name: 'black/white contrast == 21', pass: approx(bw, 21, 0.01), got: bw.toFixed(2) });

  // 2. oklch white/black sanity (matches index.css --background/--foreground stock).
  cases.push({ name: 'oklch(1 0 0) -> #ffffff', pass: toHex(parseColor('oklch(1 0 0)')) === '#ffffff', got: toHex(parseColor('oklch(1 0 0)')) });
  cases.push({ name: 'oklch(0 0 0) -> #000000', pass: toHex(parseColor('oklch(0 0 0)')) === '#000000', got: toHex(parseColor('oklch(0 0 0)')) });

  // 3. Mid-grey oklch is achromatic (r==g==b) and mid-range.
  const grey = parseColor('oklch(0.556 0 0)');
  cases.push({
    name: 'oklch(0.556 0 0) is achromatic grey',
    pass: grey.r === grey.g && grey.g === grey.b && grey.r > 90 && grey.r < 160,
    got: toHex(grey),
  });

  // 4. WCAG threshold table is wired correctly (4.5 -> AA normal pass, AAA normal fail).
  const v = wcagVerdict(4.5);
  cases.push({ name: 'ratio 4.5 => AA normal pass, AAA normal fail', pass: v.AA_normal && !v.AAA_normal, got: JSON.stringify(v) });

  let ok = true;
  for (const c of cases) {
    process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (got ${c.got})\n`);
    if (!c.pass) ok = false;
  }
  process.stdout.write(ok ? '\nself-check: ALL PASS\n' : '\nself-check: FAILURES\n');
  return ok;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = { theme: 'light', css: DEFAULT_CSS, json: false };
  const positional = [];
  const readFlagValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--theme') {
      flags.theme = readFlagValue(i, a);
      i++;
    }
    else if (a === '--css') {
      flags.css = readFlagValue(i, a);
      i++;
    }
    else if (a === '--json') flags.json = true;
    else if (a === '--selfcheck' || a === '--help' || a === '-h') positional.push(a);
    else positional.push(a);
  }
  return { flags, positional };
}

const HELP = `resolve-token.mjs — Paperclip design-token + WCAG resolver

  node scripts/ui-review/resolve-token.mjs <token> [--theme light|dark]
  node scripts/ui-review/resolve-token.mjs contrast <fg> <bg> [--theme light|dark]
  node scripts/ui-review/resolve-token.mjs --selfcheck

  <token>     --muted-foreground | muted-foreground | colors.muted-foreground
  <fg>/<bg>   a token name OR a literal color (#hex, rgb(), hsl(), oklch(), oklab())

  --theme     light | dark   (default light)
  --css       path to tokens css (default ui/src/index.css)
  --json      machine-readable output
`;

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exit(2);
  }
  const { flags, positional } = parsed;

  if (positional.includes('--help') || positional.includes('-h') || positional.length === 0) {
    process.stdout.write(HELP);
    process.exit(positional.length === 0 ? 1 : 0);
  }
  if (positional.includes('--selfcheck')) {
    process.exit(selfCheck() ? 0 : 1);
  }

  let css;
  try {
    css = readFileSync(flags.css, 'utf8');
  } catch (e) {
    process.stderr.write(`ERROR: cannot read tokens css at ${flags.css}: ${e.message}\n`);
    process.exit(2);
  }
  const themeMap = buildThemeMap(css, flags.theme);

  try {
    if (positional[0] === 'contrast') {
      const [, fgArg, bgArg] = positional;
      if (!fgArg || !bgArg) {
        process.stderr.write('ERROR: contrast needs <fg> and <bg>\n');
        process.exit(2);
      }
      const fg = resolveColorArg(fgArg, themeMap);
      const bg = resolveColorArg(bgArg, themeMap);
      const verdict = wcagVerdict(contrastRatio(fg.rgb, bg.rgb));
      if (flags.json) {
        process.stdout.write(JSON.stringify({ theme: flags.theme, fg, bg, ...verdict }, null, 2) + '\n');
      } else {
        const mark = (b) => (b ? 'PASS' : 'FAIL');
        process.stdout.write(
          `theme:      ${flags.theme}\n` +
            `fg:         ${fgArg}  ->  ${fg.hex}  (${fg.source})\n` +
            `bg:         ${bgArg}  ->  ${bg.hex}  (${bg.source})\n` +
            `ratio:      ${verdict.ratio}:1\n` +
            `AA  normal (>=4.5): ${mark(verdict.AA_normal)}\n` +
            `AA  large  (>=3.0): ${mark(verdict.AA_large)}\n` +
            `AAA normal (>=7.0): ${mark(verdict.AAA_normal)}\n` +
            `AAA large  (>=4.5): ${mark(verdict.AAA_large)}\n`,
        );
      }
    } else {
      const arg = positional[0];
      const resolved = resolveColorArg(arg, themeMap);
      if (flags.json) {
        process.stdout.write(JSON.stringify({ theme: flags.theme, token: arg, ...resolved }, null, 2) + '\n');
      } else {
        process.stdout.write(
          `theme:    ${flags.theme}\n` +
            `token:    ${arg}${resolved.key ? `  (${resolved.key})` : ''}\n` +
            `value:    ${resolved.source}\n` +
            `hex:      ${resolved.hex}\n` +
            `rgb:      rgb(${resolved.rgb.r}, ${resolved.rgb.g}, ${resolved.rgb.b})\n`,
        );
      }
    }
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exit(2);
  }
}

main();
