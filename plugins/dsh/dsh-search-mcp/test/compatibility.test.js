import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

test('package exports resolve and host dependencies stay pinned to the local host version', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.browser.js');
  assert.equal(pkg.engines.node, '>=20');

  for (const name of [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-launch-environment',
  ]) {
    assert.equal(pkg.dependencies[name], '0.1.5-rc.2');
  }
  // 适配版不依赖 dsh-settings：发布版缺 installSettingsSection/settingsNamespace（见 lib/host-shims.js）
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-settings'], undefined);
  // 适配版不再依赖 dsh-web：provider 抛的是本地 WebError（见 lib/web-error.js）
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-web'], undefined);
  assert.equal(pkg.dependencies['@deepseek-ai/schemastery'], '3.18.2');
  assert.equal(pkg.dependencies.undici, '6.28.0');
  assert.equal(pkg.dependencies['ipaddr.js'], '2.5.0');
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'], '1.30.0');
});

test('RC2 browser bundle uses keyed settings slot and credential migration', async () => {
  const client = await read('lib/client.browser.js');
  assert.match(client, /name: "settings\.plugin\.item",\s+key: NS,/);
  assert.doesNotMatch(client, /name: "settings\.plugin\.item",\s+id:/);
  assert.match(client, /api\.settings\.describe\(\{\}\)/);
  assert.match(client, /api\.credentials\.describe\(\{ refs: refs\.slice\(index, index \+ CREDENTIAL_DESCRIBE_BATCH_SIZE\) \}\)/);
  assert.match(client, /api\.credentials\.set\(\{ ref, value \}\)/);
  assert.match(client, /credentials\/reference-updated/);
  assert.match(client, /CREDENTIAL_DESCRIBE_BATCH_SIZE = 64/);
  assert.match(client, /api\.credentials\.unset\(\{ ref \}\)/);
  assert.match(client, /rollbackSettingsWrites/);
  assert.match(client, /legacyKeyBlocked/);
  assert.match(client, /deepEqualJson\(current\[field\], value\)/);
});

test('known providers are CDKey-only while custom keeps advanced fields', async () => {
  const client = await read('lib/client.browser.js');
  const catalog = client.slice(client.indexOf('const CATALOG = {'), client.indexOf('const KIND_OPTIONS'));
  assert.doesNotMatch(catalog, /https?:\/\//);
  assert.doesNotMatch(catalog, /toolName|authParam|transport/);
  assert.match(client, /const known = row\.kind !== "custom"/);
  assert.match(client, /children: known \? \[/);
  assert.match(client, /No endpoint is required for known providers/);
  assert.match(client, /已知提供商不需要填写端点链接/);
  assert.match(client, /kind, apiKey: "", apiKeyEnv: ""/);
});

test('HTTP transport pins DNS and applies one guarded fetch to every SDK request', async () => {
  const transport = await read('lib/client.js');
  assert.match(transport, /validateHttpEndpoint\(server\.url, \{ signal \}\)/);
  assert.match(transport, /new Agent\(\{[\s\S]*connect: \{ lookup: validated\.lookup \}/);
  assert.match(transport, /requestUrl\.origin !== expectedOrigin/);
  assert.match(transport, /dispatcher: agent/);
  assert.match(transport, /redirect: 'error'/);
  assert.match(transport, /fetch: secureFetch/);
  assert.match(transport, /await client\.close\(\)[\s\S]*await runtime\?\.close\(\)/);
  assert.doesNotMatch(transport, /new URL\(server\.url\)[\s\S]*new StreamableHTTPClientTransport\(url, \{\s*requestInit:/);
});
test('bundle switches the search provider and keeps the fetch path intact', async () => {
  const patch = await read('cordis.patch.yml');
  // 适配点③：装上但**默认不切换**——provider 行插进来，web.searchProvider 仍是内置的
  assert.match(patch, /id: search-mcp/);
  assert.match(patch, /searchProvider: deepseek-official/);
  assert.match(patch, /改成 search-mcp/); // 启用说明必须留在注释里，人才知道怎么切
  assert.doesNotMatch(patch, /^\s*searchProvider: search-mcp\s*$/mu);
  // 适配点①：不 disabled 内置搜索提供方——切回内置搜索只需删掉 searchProvider 那两行
  assert.doesNotMatch(patch, /- id: web-search-deepseek\s+disabled: true/);
  // 适配点②：tool-web 保持 fetch: true —— 上游会顺手关掉 fetch，那会让 web_fetch / web_read 一起失效
  assert.match(patch, /- id: tool-web\s+disabled: false/);
  assert.match(patch, /fetch: true/);
  assert.doesNotMatch(patch, /fetch: false/);
  assert.match(patch, /searchMaxResults: 50/);
  assert.match(patch, /searchMaxQueries: 4/);
  // 默认 server 行保持 endpoint-free（免 key 的 DuckDuckGo：只给 id/kind/maxResults；注释行不算）
  const block = patch.slice(patch.indexOf('- id: duckduckgo'), patch.indexOf('- id: web'));
  const effective = block.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(effective, /url:|toolName:|authParam:|transport:|apiKey/);
});
