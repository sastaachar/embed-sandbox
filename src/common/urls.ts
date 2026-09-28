/** Where a project can be opened. Shared so the API and MCP never drift apart. */
export function publicUrls(origin: string, projectId: string) {
  return {
    siteUrl: `${origin}/p/${projectId}/`,
    builderUrl: `${origin}/build/${projectId}`,
    connectUrl: `${origin}/build/${projectId}#connect=1`,
    forkUrl: `${origin}/fork/${projectId}`,
    mcpUrl: `${origin}/mcp/${projectId}`,
    apiUrl: `${origin}/api/projects/${projectId}`,
  };
}

/**
 * The link you hand a human so they can connect a cluster: the builder, with the edit
 * token in the fragment and the Connect dialog already up. A fragment is never sent to
 * the server, and the builder strips it from the address bar as soon as it reads it, so
 * the token does not linger in history, bookmarks or a shared screenshot.
 */
export function connectLink(origin: string, projectId: string, buildId: string) {
  return `${origin}/build/${projectId}#t=${encodeURIComponent(buildId)}&connect=1`;
}
