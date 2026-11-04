/** MCP transport layer for one search. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebError } from './web-error.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { clampSearchResults } from './catalog.js';
import { validateHttpEndpoint } from './url-policy.js';

/** Run one search through a resolved server entry. */
export async function callMcpSearch(server, key, args, signal) {
  if (!server.toolName) {
    throw new WebError(
      `search-mcp server "${server.id}": no MCP tool name (set "toolName" or pick a known kind)`,
      'WEB_PROVIDER_ERROR',
    );
  }

  let runtime;
  const client = new Client({ name: 'dsh-search-mcp', version: '0.2.0' }, { capabilities: {} });
  try {
    runtime = server.transport === 'stdio'
      ? { transport: stdioTransport(server, key), close: async () => {} }
      : await httpRuntime(server, key, signal);
    await race(client.connect(runtime.transport), signal, `connect to "${server.id}"`);
    const callArgs = { query: args.query };
    if (server.countArg.length > 0 && args.maxResults !== undefined) {
      callArgs[server.countArg] = clampSearchResults(server, args.maxResults);
    }
    const result = await race(
      client.callTool({ name: server.toolName, arguments: callArgs }),
      signal,
      `call "${server.id}" tool "${server.toolName}"`,
    );
    if (result.isError) {
      throw new WebError(
        `search-mcp: MCP server "${server.id}" tool "${server.toolName}" reported an error`,
        'WEB_PROVIDER_ERROR',
      );
    }
    return result;
  } catch (error) {
    if (error instanceof WebError) throw error;
    if (signal?.aborted) throw aborted(`complete request for "${server.id}"`);
    const detail = error?.name === 'SearchMcpUrlPolicyError' ? `: ${error.message}` : '';
    throw new WebError(
      `search-mcp server "${server.id}" request failed${detail}`,
      'WEB_PROVIDER_ERROR',
    );
  } finally {
    try {
      await client.close();
    } catch {
      // The connection is already gone.
    }
    try {
      await runtime?.close();
    } catch {
      // The dedicated dispatcher has no shared state to recover.
    }
  }
}

/** Build a DNS-pinned streamable-http transport and its cleanup. */
async function httpRuntime(server, key, signal) {
  const validated = await validateHttpEndpoint(server.url, { signal });
  const url = new URL(validated.url);
  const headers = {};
  if (key !== undefined && key.length > 0 && server.authParam.length > 0) {
    const value = `${server.authPrefix ?? ''}${key}`;
    if (server.authStyle === 'query') url.searchParams.set(server.authParam, value);
    else if (server.authStyle === 'header') headers[server.authParam] = value;
  }

  const agent = new Agent({
    connect: { lookup: validated.lookup },
    connections: validated.addresses.length,
    maxRedirections: 0,
  });
  const expectedOrigin = url.origin;
  const secureFetch = async (input, init = {}) => {
    const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (requestUrl.origin !== expectedOrigin) {
      throw new Error('search-mcp URL policy: request origin changed after validation');
    }
    return undiciFetch(input, {
      ...init,
      dispatcher: agent,
      redirect: 'error',
      ...(signal !== undefined ? { signal: combineSignals(signal, init.signal) } : {}),
    });
  };

  return {
    transport: new StreamableHTTPClientTransport(url, {
      fetch: secureFetch,
      requestInit: {
        headers,
        redirect: 'error',
        ...(signal !== undefined ? { signal } : {}),
      },
    }),
    close: () => agent.close(),
  };
}

/** Build a stdio transport; the authParam name doubles as the env var name. */
function stdioTransport(server, key) {
  const env = { ...process.env };
  if (key !== undefined && key.length > 0 && server.authParam.length > 0) {
    env[server.authParam] = `${server.authPrefix ?? ''}${key}`;
  }
  return new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env,
  });
}

/** Race a protocol operation against the caller/timeout abort signal. */
function race(promise, signal, stage) {
  if (signal === undefined) return promise;
  if (signal.aborted) throw aborted(stage);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(aborted(stage));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function combineSignals(base, request) {
  if (request === undefined || request === null || request === base) return base;
  return AbortSignal.any([base, request]);
}

function aborted(stage) {
  return new WebError(`search-mcp: aborted while trying to ${stage}`, 'WEB_ABORTED');
}
