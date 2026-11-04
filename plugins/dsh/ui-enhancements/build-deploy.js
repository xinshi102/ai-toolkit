#!/usr/bin/env node
/* Build + deploy the @local plugins (skins / toggles / market / codex-consumer).
 * NOTE: @local/dsh-codex-bridge is owned by Codex (codex-bridge-plugin) and is
 * NOT managed here — this script never touches its files or symlink. */
'use strict';
const fs = require('fs');
const path = require('path');

const WS = __dirname;
const PROF = process.env.DSH_PROFILE_DIR || path.join(require('os').homedir(), '.dsh/profiles/web');
const PLUGINS_ROOT = path.join(PROF, 'plugins');

const read = p => fs.readFileSync(p, 'utf8');
const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };

function hostIndex(name) {
  return `/**
 * Host half of ${name}.
 * Client-only package: the Loader still imports the default entry.
 */
export const name = ${JSON.stringify(name)};
export function apply() {}
`;
}

function clientBundle(name, inject, bodyJs) {
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${bodyJs.split('\n').map(l => '\t\t' + l).join('\n')}
\t\texports.name = ${JSON.stringify(name)};
\t\texports.inject = ${JSON.stringify(inject)};
\t\treturn module.exports;
\t}
});
`;
}

function packageJson(name, inject, immediately) {
  return JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    description: 'DSH client plugin (local)',
    type: 'module',
    exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' },
    dsh: { client: { platform: 'web', inject, immediately: !!immediately } },
    files: ['lib']
  }, null, 2) + '\n';
}

function hostPackageJson(name) {
  return JSON.stringify({
    name, version: '0.1.1', private: true,
    description: 'DSH host plugin (local)',
    type: 'module',
    exports: { '.': './lib/index.js', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['lib', 'cordis.patch.yml']
  }, null, 2) + '\n';
}

const plugins = {
  'dsh-plugin-center': {
    inject: ['loader', 'modules', 'slots'],
    immediately: true,
    body: read(path.join(WS, 'plugins/center/plugin-body.js'))
  },
  'dsh-ui-skins': {
    inject: [],
    immediately: true,
    body: read(path.join(WS, 'dsh-ui-skins.js')),
    asApplyBody: true
  },
  'dsh-ui-toggles': {
    inject: ['loader', 'modules'],
    immediately: true,
    body: read(path.join(WS, 'plugins/toggles/plugin-body.js'))
  },
  'dsh-ui-market': {
    inject: ['remote', 'remote.pluginInventory'],
    immediately: false,
    body: read(path.join(WS, 'plugins/market/plugin-body.js'))
  },
  'dsh-codex-consumer': {
    hostOnly: true,
    hostSource: path.join(WS, 'plugins/codex-consumer/lib/index.js')
  }
};

for (const [dir, cfg] of Object.entries(plugins)) {
  const name = '@local/' + dir;
  const root = path.join(PLUGINS_ROOT, dir);
  if (cfg.hostOnly) {
    write(path.join(root, 'package.json'), hostPackageJson(name));
    write(path.join(root, 'lib/index.js'), read(cfg.hostSource));
    write(path.join(root, 'cordis.patch.yml'), `- insert:\n    - id: codex-consumer\n      name: '${name}'\n`);
    console.log('built', name, '(host-only)');
    continue;
  }
  let bodyJs = cfg.body;
  if (cfg.asApplyBody) {
    bodyJs = `\t\texports.apply = (ctx) => {\n${cfg.body.split('\n').map(l => '\t\t\t' + l).join('\n')}\n\t\t};`;
  } else {
    bodyJs = bodyJs + '\n\t\texports.apply = apply;';
  }
  write(path.join(root, 'package.json'), packageJson(name, cfg.inject, cfg.immediately));
  write(path.join(root, 'lib/index.js'), hostIndex(name));
  write(path.join(root, 'lib/client.js'), clientBundle(name, cfg.inject, bodyJs));
  console.log('built', name);
}

// symlink into profile node_modules (skip dsh-codex-bridge — owned by Codex)
const nmLocal = path.join(PROF, 'node_modules/@local');
fs.mkdirSync(nmLocal, { recursive: true });
for (const dir of Object.keys(plugins)) {
  const link = path.join(nmLocal, dir);
  const target = path.relative(nmLocal, path.join(PLUGINS_ROOT, dir));
  try { fs.unlinkSync(link); } catch (e) {}
  fs.symlinkSync(target, link, 'dir');
  console.log('linked', link, '->', target);
}

// profile package.json dependencies (keep codex-bridge dep if present)
const pkgPath = path.join(PROF, 'package.json');
const pkg = JSON.parse(read(pkgPath));
pkg.dependencies = pkg.dependencies || {};
for (const dir of Object.keys(plugins)) pkg.dependencies['@local/' + dir] = `file:./plugins/${dir}`;
if (!pkg.dependencies['@local/dsh-codex-bridge'] && fs.existsSync(path.join(PLUGINS_ROOT, 'dsh-codex-bridge/package.json'))) {
  pkg.dependencies['@local/dsh-codex-bridge'] = 'file:./plugins/dsh-codex-bridge';
}
write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('profile package.json deps updated');

// cordis.patch.yml — ensure the managed rows exist; never remove the codex-bridge row
const patchPath = path.join(PROF, 'cordis.patch.yml');
let patch = read(patchPath);
const managedRows = [
  ['plugin-center', '@local/dsh-plugin-center'],
  ['ui-skins', '@local/dsh-ui-skins'],
  ['ui-toggles', '@local/dsh-ui-toggles'],
  ['ui-market', '@local/dsh-ui-market'],
  ['codex-consumer', '@local/dsh-codex-consumer']
];
for (const [id, name] of managedRows) {
  const rowRe = new RegExp(`- id: ${id}\\n\\s*name: '${name}'`, 'm');
  if (!rowRe.test(patch)) {
    patch = patch.replace(/- insert:\n/, `- insert:\n    - id: ${id}\n      name: '${name}'\n`);
  }
}
write(patchPath, patch);
console.log('cordis.patch.yml updated');
