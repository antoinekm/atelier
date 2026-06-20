import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';

const NODE = process.execPath;
const SCRIPT = new URL('./resolve-token.mjs', import.meta.url).pathname;

function run(args) {
  return execFileSync(NODE, [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runJson(args) {
  return JSON.parse(run([...args, '--json']));
}

function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function isAchromatic({ r, g, b }) {
  return r === g && g === b;
}

test('selfcheck validates known WCAG and color conversion fixtures', () => {
  const output = run(['--selfcheck']);

  assert.match(output, /black\/white contrast == 21/);
  assert.match(output, /self-check: ALL PASS/);
});

test('resolves light and dark theme tokens to computed colors', () => {
  const light = runJson(['muted-foreground']);
  const dark = runJson(['muted-foreground', '--theme', 'dark']);

  assert.equal(light.theme, 'light');
  assert.equal(light.key, '--muted-foreground');
  assert.equal(isHexColor(light.hex), true);
  assert.equal(isAchromatic(light.rgb), true);

  assert.equal(dark.theme, 'dark');
  assert.equal(dark.key, '--muted-foreground');
  assert.equal(isHexColor(dark.hex), true);
  assert.equal(isAchromatic(dark.rgb), true);
  assert.notEqual(dark.hex, light.hex);
});

test('computes WCAG verdicts for token contrast checks', () => {
  const light = runJson(['contrast', 'muted-foreground', 'background']);
  const dark = runJson(['contrast', 'muted-foreground', 'background', '--theme', 'dark']);

  assert.equal(light.ratio > 1, true);
  assert.equal(light.AA_normal, true);

  assert.equal(dark.ratio > light.ratio, true);
  assert.equal(dark.AA_normal, true);
  assert.equal(dark.AAA_normal, true);
});

test('rejects flags that are missing their values', () => {
  const result = spawnSync(NODE, [SCRIPT, '--theme', '--selfcheck'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR: --theme needs a value/);
});
