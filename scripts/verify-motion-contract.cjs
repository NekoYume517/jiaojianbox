const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const web = path.join(root, 'web');
const read = name => fs.readFileSync(path.join(web, name), 'utf8');
const compact = value => value.replace(/\s+/g, '');
const files = extension => fs.readdirSync(web).filter(name => name.endsWith(extension));
const cssFiles = files('.css');
const jsFiles = files('.js');

// Files with reviewed, specialized motion are explicit. New modules must use uiMotion.
const approvedDirectAnimation = new Set(['motion.js', 'navigation.js', 'experience.js']);
const approvedModalOwners = new Set(['motion.js', 'native.js']);
const allowedDurations = new Set([
  0.01, 1, 40, 80, 100, 120, 130, 140, 150, 160, 170, 180, 200, 210, 220, 240, 250, 260, 280, 300, 440,
]);
const allowedStatusAnimationDurations = new Set([
  ...allowedDurations, 340, 500, 1100, 1150, 1500, 1600, 2000,
]);

test('canonical motion tokens are exact', () => {
  const motion = compact(read('motion.css'));
  assert.match(motion, /--motion-ease:cubic-bezier\(\.2,\.8,\.2,1\)/);
  assert.match(motion, /--motion-out:cubic-bezier\(\.23,1,\.32,1\)/);
  assert.match(compact(read('app.css')), /--ease-drawer:cubic-bezier\(\.32,\.72,0,1\)/);
});

test('main shell loads one runtime and quick collector loads none', () => {
  const index = read('index.html');
  assert.equal((index.match(/src=["']\.\/motion\.js["']/g) || []).length, 1);
  assert.equal((index.match(/href=["']\.\/motion\.css["']/g) || []).length, 1);
  assert.doesNotMatch(read('quick.html'), /motion\.(?:css|js)|uiMotion/);
  assert.equal((compact(read('motion.js')).match(/window\.uiMotion=/g) || []).length, 1);
});

test('motion runtime exposes the shared contract and reduced-motion path', () => {
  const runtime = compact(read('motion.js'));
  for (const api of [
    'adoptSegment',
    'relayout',
    'openDialog',
    'closeDialog',
    'syncNavigation',
    'syncSegments',
    'revealSubnavigation',
    'hideSubnavigation',
  ]) {
    assert.match(runtime, new RegExp(`\\b${api}\\b`), `uiMotion.${api} is missing`);
  }
  assert.match(runtime, /matchMedia\(['"]\(prefers-reduced-motion:reduce\)['"]\)/);
  assert.match(runtime, /reduced\.addEventListener\(['"]change['"]/);
  assert.match(compact(read('motion.css')), /@media\(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important;transition:none!important/);
});

test('forbidden broad motion and unreviewed animation libraries stay out', () => {
  for (const name of cssFiles) {
    assert.doesNotMatch(read(name), /transition(?:-property)?\s*:\s*all\b/i, `${name} uses transition: all`);
  }
  const html = `${read('index.html')}\n${read('quick.html')}`;
  assert.doesNotMatch(html, /(?:gsap|animejs|framer-motion|motion-one)/i);
  for (const name of jsFiles) {
    const source = read(name);
    if (source.includes('.animate(')) {
      assert.ok(approvedDirectAnimation.has(name), `${name} calls .animate() without a reviewed motion exception`);
    }
    if (source.includes('.showModal(')) {
      assert.ok(approvedModalOwners.has(name), `${name} bypasses uiMotion.openDialog`);
    }
    if (source.includes('dialog.close(')) {
      assert.ok(approvedModalOwners.has(name), `${name} bypasses uiMotion.closeDialog`);
    }
  }
});

test('declared interface durations and shared easings remain in contract', () => {
  const timePattern = /(\d*\.?\d+)(ms|s)\b/g;
  for (const name of cssFiles) {
    const source = read(name);
    for (const declaration of source.matchAll(/(?:animation(?:-duration)?|transition(?:-duration)?)\s*:\s*([^;}]+)/g)) {
      const isAnimation = declaration[0].trimStart().startsWith('animation');
      for (const match of declaration[1].matchAll(timePattern)) {
        const duration = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
        const allowed = isAnimation ? allowedStatusAnimationDurations : allowedDurations;
        assert.ok(allowed.has(duration), `${name} uses unapproved ${duration}ms motion`);
      }
    }
  }
  for (const name of approvedDirectAnimation) {
    const source = read(name);
    const lines = source.split(/\r?\n/);
    for (const match of source.matchAll(/\bduration\s*:\s*(\d+)/g)) {
      assert.ok(allowedDurations.has(Number(match[1])), `${name} uses unapproved ${match[1]}ms motion`);
    }
    lines.forEach((line, index) => {
      if (!/easing\s*:\s*['"](?:linear|ease|ease-in|ease-out|ease-in-out)['"]/.test(line)) return;
      const context = lines.slice(Math.max(0, index - 2), index + 2).join('\n');
      assert.match(context, /\bbackdrop\b/, `${name} must use a canonical curve outside backdrop opacity`);
    });
  }
});

test('shared highlights, charts and theme transition stay deterministic', () => {
  const motionCss = compact(read('motion.css'));
  assert.match(motionCss, /\.nav-highlight\{/);
  assert.match(motionCss, /\.segment-highlight\{/);
  assert.match(motionCss, /html\.theming[^}]*transition:background-color250ms/);
  assert.match(compact(read('statistics.js')), /animation:false/);
});
