const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const web = path.join(root, 'web');
const read = relative => fs.readFileSync(path.join(web, relative), 'utf8');

test('HTML local assets exist', () => {
  for (const htmlName of ['index.html', 'quick.html']) {
    const html = read(htmlName);
    const assets = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map(match => match[1])
      .filter(asset => !/^(?:[a-z]+:|#|\/\/)/i.test(asset));
    for (const asset of assets) {
      const relative = asset.replace(/^\.\//, '').replace(/[?#].*$/, '');
      assert.ok(fs.existsSync(path.join(web, relative)), `${htmlName} references missing ${relative}`);
    }
  }
});

test('top-level browser scripts parse as classic scripts', () => {
  for (const name of fs.readdirSync(web).filter(name => name.endsWith('.js'))) {
    const source = read(name);
    if (/^\s*(?:import|export)\s/m.test(source)) continue;
    assert.doesNotThrow(() => new vm.Script(source, { filename: name }), `${name} has invalid syntax`);
  }
});

test('static HTML has no duplicate ids', () => {
  for (const htmlName of ['index.html', 'quick.html']) {
    const ids = [...read(htmlName).matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${htmlName} contains duplicate ids`);
  }
});

test('quick collector stays independent from the main motion runtime', () => {
  const quick = read('quick.html');
  assert.doesNotMatch(quick, /motion\.(?:css|js)|uiMotion/);
  assert.match(read('index.html'), /\.\/motion\.js/);
});

test('main shell keeps required shared UI assets', () => {
  const html = read('index.html');
  for (const asset of [
    './app.css',
    './workspace.css',
    './motion.css',
    './motion.js',
    './navigation.js',
    './controls.js',
    './file-picker.js',
  ]) {
    assert.match(html, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
