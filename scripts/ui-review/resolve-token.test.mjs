import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('selfcheck validates known WCAG and color conversion fixtures', () => {
  const output = run(['--selfcheck']);

  assert.match(output, /black\/white contrast == 21/);
  assert.match(output, /self-check: ALL PASS/);
});

test('resolves light and dark theme tokens to computed hex values', () => {
  const light = runJson(['muted-foreground']);
  const dark = runJson(['muted-foreground', '--theme', 'dark']);

  assert.equal(light.theme, 'light');
  assert.equal(light.key, '--muted-foreground');
  assert.equal(light.hex, '#737373');

  assert.equal(dark.theme, 'dark');
  assert.equal(dark.key, '--muted-foreground');
  assert.equal(dark.hex, '#a1a1a1');
});

test('computes WCAG verdicts for token contrast checks', () => {
  const light = runJson(['contrast', 'muted-foreground', 'background']);
  const dark = runJson(['contrast', 'muted-foreground', 'background', '--theme', 'dark']);

  assert.equal(light.ratio, 4.74);
  assert.equal(light.AA_normal, true);
  assert.equal(light.AAA_normal, false);

  assert.equal(dark.ratio, 7.66);
  assert.equal(dark.AA_normal, true);
  assert.equal(dark.AAA_normal, true);
});
