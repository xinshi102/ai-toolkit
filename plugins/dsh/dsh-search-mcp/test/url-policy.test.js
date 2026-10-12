import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinnedLookup, isPublicAddress, validateHttpEndpoint } from '../lib/url-policy.js';

const lookup = (records) => (_hostname, options, callback) => {
  assert.equal(options.all, true);
  queueMicrotask(() => callback(null, records));
};

test('URL policy accepts HTTP(S) with public DNS only', async () => {
  const result = await validateHttpEndpoint('https://search.example/mcp', {
    lookup: lookup([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700:0:0:0:0:1111', family: 6 },
    ]),
  });
  assert.equal(result.url.hostname, 'search.example');
  assert.deepEqual(result.addresses, [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700:0:0:0:0:1111', family: 6 },
  ]);
});

test('URL policy rejects schemes, userinfo, localhost, and ambiguous IPv4', async () => {
  for (const input of [
    'ftp://example.com/mcp',
    'https://user:pass@example.com/mcp',
    'http://localhost/mcp',
    'http://api.localhost/mcp',
    'http://127.0.0.1/mcp',
    'http://127.1/mcp',
    'http://0177.0.0.1/mcp',
    'http://0x7f000001/mcp',
  ]) {
    await assert.rejects(() => validateHttpEndpoint(input), { name: 'SearchMcpUrlPolicyError' }, input);
  }
});

test('URL policy rejects private, reserved, test, mapped, and transition ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::7f00:1',
    '::a00:1',
    '::a9fe:a9fe',
    '::c0a8:101',
    '::808:808',
    '64:ff9b::808:808',
    '2001:db8::1',
    '2001::1',
    '2002:0808:0808::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('URL policy rejects mixed public and private DNS answers', async () => {
  await assert.rejects(
    () => validateHttpEndpoint('https://search.example/mcp', {
      lookup: lookup([
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    }),
    /non-public address/,
  );
});

test('URL policy rejects DNS errors and empty answers without leaking endpoint data', async () => {
  await assert.rejects(
    () => validateHttpEndpoint('https://search.example/mcp', {
      lookup: (_hostname, _options, callback) => callback(new Error('resolver detail')),
    }),
    /resolution failed/,
  );
  await assert.rejects(
    () => validateHttpEndpoint('https://search.example/mcp', { lookup: lookup([]) }),
    /did not resolve/,
  );
});

test('URL policy aborts a pending DNS lookup', async () => {
  const controller = new AbortController();
  const pending = validateHttpEndpoint('https://search.example/mcp', {
    lookup: () => {},
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /validation was aborted/);
});

test('pinned lookup serves only validated host and addresses', async () => {
  const pinned = createPinnedLookup('search.example', [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700:0:0:0:0:1111', family: 6 },
  ]);
  const all = await new Promise((resolve, reject) => {
    pinned('search.example', { all: true }, (error, records) => error ? reject(error) : resolve(records));
  });
  assert.deepEqual(all, [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700:0:0:0:0:1111', family: 6 },
  ]);
  await assert.rejects(new Promise((resolve, reject) => {
    pinned('other.example', {}, (error, address) => error ? reject(error) : resolve(address));
  }), /unvalidated hostname/);
});
