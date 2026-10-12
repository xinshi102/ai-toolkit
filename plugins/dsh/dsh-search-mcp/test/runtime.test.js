import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSearchResults, SEARCH_MCP_CATALOG, resolveServer } from '../lib/catalog.js';
import { extractSearchResult } from '../lib/extract.js';

test('catalog exposes every supported provider preset', () => {
  assert.deepEqual(Object.keys(SEARCH_MCP_CATALOG), [
    'tavily',
    'brave',
    'exa',
    'perplexity',
    'duckduckgo',
    'custom',
  ]);
});

test('known providers ignore stored connection overrides', () => {
  const tavily = resolveServer({
    id: 'primary',
    kind: 'tavily',
    transport: 'stdio',
    url: 'https://example.test/mcp',
    authStyle: 'header',
    authParam: 'X-Other-Key',
    toolName: 'other_search',
    apiKeyEnv: 'MY_TAVILY_KEY',
    maxResults: 12,
  });
  assert.equal(tavily.transport, 'http');
  assert.equal(tavily.url, 'https://mcp.tavily.com/mcp/');
  assert.equal(tavily.authStyle, 'query');
  assert.equal(tavily.authParam, 'tavilyApiKey');
  assert.equal(tavily.toolName, 'tavily_search');
  assert.equal(tavily.countArg, 'max_results');
  assert.equal(tavily.apiKeyEnv, 'MY_TAVILY_KEY');
  assert.equal(tavily.maxResults, 12);
});

test('prototype property kinds fall back to custom', () => {
  for (const kind of ['constructor', 'toString', '__proto__']) {
    const resolved = resolveServer({ id: kind, kind, url: 'https://search.example/mcp' });
    assert.equal(resolved.kind, 'custom');
    assert.equal(resolved.url, 'https://search.example/mcp');
  }
});

test('custom providers preserve advanced connection fields', () => {
  const custom = resolveServer({
    id: 'custom',
    kind: 'custom',
    transport: 'stdio',
    command: 'custom-mcp',
    args: ['--stdio'],
    authStyle: 'header',
    authParam: 'X-Key',
    authPrefix: 'Token ',
    toolName: 'search',
  });
  assert.equal(custom.transport, 'stdio');
  assert.equal(custom.command, 'custom-mcp');
  assert.deepEqual(custom.args, ['--stdio']);
  assert.equal(custom.authParam, 'X-Key');
  assert.equal(custom.authPrefix, 'Token ');
  assert.equal(custom.toolName, 'search');
});

test('provider contracts match current upstream transports', () => {
  const brave = resolveServer({ id: 'brave', kind: 'brave' });
  assert.equal(brave.transport, 'stdio');
  assert.equal(brave.command, 'npx');
  assert.deepEqual(brave.args, ['-y', '@brave/brave-search-mcp-server@2.1.3']);
  assert.equal(brave.authParam, 'BRAVE_API_KEY');

  const perplexity = resolveServer({ id: 'perplexity', kind: 'perplexity' });
  assert.equal(perplexity.url, 'https://api.perplexity.ai/mcp');
  assert.equal(perplexity.authParam, 'Authorization');
  assert.equal(perplexity.authPrefix, 'Bearer ');
  assert.equal(perplexity.toolName, 'perplexity_search');

  const duckduckgo = resolveServer({ id: 'duckduckgo', kind: 'duckduckgo' });
  assert.equal(duckduckgo.needsKey, false);
  assert.equal(duckduckgo.toolName, 'duckduckgo_web_search');
  assert.equal(duckduckgo.countArg, 'count');
});

test('provider result counts stay within upstream MCP schemas', () => {
  assert.equal(clampSearchResults(resolveServer({ id: 't', kind: 'tavily' }), 1), 5);
  assert.equal(clampSearchResults(resolveServer({ id: 't', kind: 'tavily' }), 50), 20);
  assert.equal(clampSearchResults(resolveServer({ id: 'b', kind: 'brave' }), 50), 20);
  assert.equal(clampSearchResults(resolveServer({ id: 'p', kind: 'perplexity' }), 0), 1);
  assert.equal(clampSearchResults(resolveServer({ id: 'd', kind: 'duckduckgo' }), 50), 20);
  assert.equal(clampSearchResults(resolveServer({ id: 'e', kind: 'exa' }), 50), 50);
});
test('extractSearchResult normalizes, deduplicates, and rejects invalid URLs', () => {
  const result = extractSearchResult({
    structuredContent: {
      answer: 'Summary',
      results: [
        { url: 'https://example.com/a', title: 'A', content: 'alpha', published_date: '2026-08-18' },
        { url: 'https://example.com/a', title: 'Duplicate' },
        { url: 'ftp://example.com/ignored', title: 'Ignored' },
      ],
      nested: { url: 'http://example.com/b', description: 'beta' },
    },
  });

  assert.deepEqual(result, {
    sources: [
      {
        url: 'https://example.com/a',
        title: 'A',
        snippet: 'alpha',
        publishedAt: '2026-08-18',
      },
      { url: 'http://example.com/b', snippet: 'beta' },
    ],
    truncated: false,
    content: 'Summary',
  });
});

test('extractSearchResult accepts JSON and plain text MCP blocks', () => {
  const json = extractSearchResult({
    content: [{ type: 'text', text: '{"results":[{"url":"https://example.com"}]}' }],
  });
  assert.equal(json.sources.length, 1);

  const text = extractSearchResult({ content: [{ type: 'text', text: 'Direct answer' }] });
  assert.deepEqual(text, { sources: [], truncated: false, content: 'Direct answer' });
});
