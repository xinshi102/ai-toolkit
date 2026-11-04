import { lookup as dnsLookup } from 'node:dns';
import ipaddr from 'ipaddr.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Parse and resolve one HTTP endpoint before any request is sent.
 * Every resolved address must be globally routable.
 */
export async function validateHttpEndpoint(input, options = {}) {
  if (options.signal?.aborted) throw abortedPolicyError();
  if (typeof input !== 'string' || input.length === 0 || input !== input.trim()) {
    throw policyError('endpoint must be a non-empty canonical URL');
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw policyError('endpoint is not a valid URL');
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw policyError('endpoint protocol must be http or https');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw policyError('endpoint must not contain user information');
  }
  if (url.hostname.length === 0) {
    throw policyError('endpoint hostname is missing');
  }

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  const comparable = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (comparable === 'localhost' || comparable.endsWith('.localhost')) {
    throw policyError('localhost endpoints are not allowed');
  }
  rejectAmbiguousIpv4(input, comparable);

  let addresses;
  if (ipaddr.isValid(comparable)) {
    addresses = [{ address: normalizeAddress(comparable), family: addressFamily(comparable) }];
  } else {
    addresses = await resolveAll(comparable, options.lookup ?? dnsLookup, options.signal);
  }
  if (addresses.length === 0) {
    throw policyError('endpoint hostname did not resolve');
  }

  const normalized = deduplicateAddresses(addresses);
  for (const record of normalized) {
    if (!isPublicAddress(record.address)) {
      throw policyError('endpoint hostname resolves to a non-public address');
    }
  }

  return Object.freeze({
    url,
    hostname: comparable,
    addresses: Object.freeze(normalized.map((record) => Object.freeze(record))),
    lookup: createPinnedLookup(comparable, normalized),
  });
}

/** Return true only for globally routable IPv4 or IPv6 addresses. */
export function isPublicAddress(input) {
  let address;
  try {
    address = ipaddr.parse(stripIpv6Brackets(input));
  } catch {
    return false;
  }
  if (address.kind() === 'ipv6') {
    if (address.isIPv4MappedAddress()) {
      address = address.toIPv4Address();
    } else if (isIpv4CompatibleAddress(address)) {
      return false;
    }
  }
  return address.range() === 'unicast';
}

/** Build a Node-compatible DNS lookup that never resolves beyond the pinned set. */
export function createPinnedLookup(hostname, records) {
  const target = normalizeHostname(hostname);
  const frozen = deduplicateAddresses(records);
  let cursor = 0;
  return (requested, options, callback) => {
    const requestedHost = normalizeHostname(requested);
    if (requestedHost !== target) {
      const error = policyError('connection attempted an unvalidated hostname');
      error.code = 'EACCES';
      queueMicrotask(() => callback(error));
      return;
    }

    const lookupOptions = typeof options === 'object' && options !== null ? options : {};
    const family = Number(lookupOptions.family) || 0;
    const candidates = family === 4 || family === 6
      ? frozen.filter((record) => record.family === family)
      : frozen;
    if (candidates.length === 0) {
      const error = policyError('no validated address matches the requested family');
      error.code = 'ENOTFOUND';
      queueMicrotask(() => callback(error));
      return;
    }
    if (lookupOptions.all === true) {
      queueMicrotask(() => callback(null, candidates.map((record) => ({ ...record }))));
      return;
    }
    const selected = candidates[cursor++ % candidates.length];
    queueMicrotask(() => callback(null, selected.address, selected.family));
  };
}

function resolveAll(hostname, lookup, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedPolicyError());
      return;
    }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortedPolicyError());
    signal?.addEventListener('abort', onAbort, { once: true });
    lookup(hostname, { all: true, verbatim: true }, (error, records) => {
      if (settled) return;
      if (error) {
        finish(reject, policyError('endpoint hostname resolution failed'));
        return;
      }
      const list = Array.isArray(records) ? records : records === undefined ? [] : [records];
      try {
        finish(resolve, list.map((record) => {
          const raw = typeof record === 'string' ? record : record.address;
          return { address: normalizeAddress(raw), family: addressFamily(raw) };
        }));
      } catch {
        finish(reject, policyError('endpoint hostname returned an invalid address'));
      }
    });
  });
}

function deduplicateAddresses(records) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    const address = normalizeAddress(record.address);
    const family = addressFamily(address);
    const key = `${family}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ address, family });
  }
  return result;
}

function normalizeAddress(input) {
  let address = ipaddr.parse(stripIpv6Brackets(input));
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) {
    address = address.toIPv4Address();
  }
  return address.toNormalizedString();
}

function addressFamily(input) {
  const address = ipaddr.parse(stripIpv6Brackets(input));
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) return 4;
  return address.kind() === 'ipv4' ? 4 : 6;
}

function rejectAmbiguousIpv4(input, hostname) {
  const authority = input.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/)?.[1] ?? '';
  const rawHost = authority.startsWith('[')
    ? authority.slice(1, authority.indexOf(']'))
    : authority.replace(/:\d*$/, '');
  if (!rawHost.includes(':') && ipaddr.IPv4.isValid(rawHost)) {
    const canonical = ipaddr.IPv4.parse(rawHost).toString();
    if (rawHost !== canonical || hostname !== canonical) {
      throw policyError('endpoint contains a non-canonical IPv4 address');
    }
  }
}

function isIpv4CompatibleAddress(address) {
  return address.parts.slice(0, 6).every((part) => part === 0);
}

function normalizeHostname(input) {
  const value = stripIpv6Brackets(String(input)).toLowerCase();
  return value.endsWith('.') ? value.slice(0, -1) : value;
}

function stripIpv6Brackets(input) {
  return input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
}

function abortedPolicyError() {
  const error = policyError('endpoint validation was aborted');
  error.code = 'ABORT_ERR';
  return error;
}

function policyError(message) {
  const error = new Error(`search-mcp URL policy: ${message}`);
  error.name = 'SearchMcpUrlPolicyError';
  return error;
}
