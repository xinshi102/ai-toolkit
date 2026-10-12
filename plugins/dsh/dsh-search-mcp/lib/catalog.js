/**
 * Search-MCP provider catalog.
 *
 * Known providers are intentionally connection-opaque to Settings clients: the
 * host owns their endpoint, transport, authentication contract and tool name.
 * `custom` is the only kind whose connection details come from the user.
 */
export const SEARCH_MCP_CATALOG = {
  tavily: {
    transport: 'http',
    url: 'https://mcp.tavily.com/mcp/',
    authStyle: 'query',
    authParam: 'tavilyApiKey',
    toolName: 'tavily_search',
    countArg: 'max_results',
    minResults: 5,
    maxResultsLimit: 20,
    apiKeyEnv: 'TAVILY_API_KEY',
    needsKey: true,
  },
  brave: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server@2.1.3'],
    authStyle: 'env',
    authParam: 'BRAVE_API_KEY',
    toolName: 'brave_web_search',
    countArg: 'count',
    minResults: 1,
    maxResultsLimit: 20,
    apiKeyEnv: 'BRAVE_API_KEY',
    needsKey: true,
  },
  exa: {
    transport: 'http',
    url: 'https://mcp.exa.ai/mcp',
    authStyle: 'header',
    authParam: 'x-api-key',
    toolName: 'web_search_exa',
    countArg: 'numResults',
    apiKeyEnv: 'EXA_API_KEY',
    needsKey: true,
  },
  perplexity: {
    transport: 'http',
    url: 'https://api.perplexity.ai/mcp',
    authStyle: 'header',
    authParam: 'Authorization',
    authPrefix: 'Bearer ',
    toolName: 'perplexity_search',
    countArg: 'max_results',
    minResults: 1,
    maxResultsLimit: 20,
    apiKeyEnv: 'PERPLEXITY_API_KEY',
    needsKey: true,
  },
  duckduckgo: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'duckduckgo-mcp-server@0.1.2'],
    authStyle: 'env',
    authParam: '',
    toolName: 'duckduckgo_web_search',
    countArg: 'count',
    minResults: 1,
    maxResultsLimit: 20,
    needsKey: false,
  },
  custom: {
    transport: 'http',
    url: '',
    authStyle: 'query',
    authParam: '',
    authPrefix: '',
    toolName: '',
    countArg: '',
    needsKey: false,
  },
};

/** The provider ids offered in the settings UI. */
export const KNOWN_KINDS = Object.keys(SEARCH_MCP_CATALOG);

export function clampSearchResults(server, value) {
  const minimum = server.minResults ?? 1;
  const maximum = server.maxResultsLimit ?? value;
  return Math.min(maximum, Math.max(minimum, value));
}

/** Resolve a stored entry without allowing known-provider connection overrides. */
export function resolveServer(server) {
  const kind = typeof server?.kind === 'string' && Object.hasOwn(SEARCH_MCP_CATALOG, server.kind)
    ? server.kind
    : 'custom';
  const preset = SEARCH_MCP_CATALOG[kind];
  if (kind !== 'custom') {
    return {
      id: typeof server.id === 'string' ? server.id : '',
      kind,
      apiKey: typeof server.apiKey === 'string' ? server.apiKey : undefined,
      apiKeyEnv: typeof server.apiKeyEnv === 'string' ? server.apiKeyEnv : '',
      maxResults: server.maxResults,
      transport: preset.transport,
      url: preset.url ?? '',
      command: preset.command ?? '',
      args: [...(preset.args ?? [])],
      authStyle: preset.authStyle ?? '',
      authParam: preset.authParam ?? '',
      authPrefix: preset.authPrefix ?? '',
      toolName: preset.toolName ?? '',
      countArg: preset.countArg ?? '',
      minResults: preset.minResults,
      maxResultsLimit: preset.maxResultsLimit,
      needsKey: preset.needsKey ?? false,
    };
  }

  return {
    id: typeof server.id === 'string' ? server.id : '',
    kind: 'custom',
    apiKey: typeof server.apiKey === 'string' ? server.apiKey : undefined,
    apiKeyEnv: typeof server.apiKeyEnv === 'string' ? server.apiKeyEnv : '',
    maxResults: server.maxResults,
    transport: server.transport || preset.transport || 'http',
    url: server.url || preset.url || '',
    command: server.command || preset.command || '',
    args: Array.isArray(server.args) ? [...server.args] : [...(preset.args ?? [])],
    authStyle: server.authStyle || preset.authStyle || '',
    authParam: server.authParam || preset.authParam || '',
    authPrefix: server.authPrefix || preset.authPrefix || '',
    toolName: server.toolName || preset.toolName || '',
    countArg: preset.countArg || '',
    minResults: preset.minResults,
    maxResultsLimit: preset.maxResultsLimit,
    needsKey: preset.needsKey ?? false,
  };
}
