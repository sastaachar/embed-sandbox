/** Where a project can be opened. Shared so the API and MCP never drift apart. */
export function publicUrls(origin: string, projectId: string) {
  return {
    siteUrl: `${origin}/p/${projectId}/`,
    builderUrl: `${origin}/build/${projectId}`,
    connectUrl: `${origin}/connect/${projectId}`,
    editUrl: `${origin}/edit/${projectId}`,
    forkUrl: `${origin}/fork/${projectId}`,
    mcpUrl: `${origin}/mcp/${projectId}`,
    apiUrl: `${origin}/api/projects/${projectId}`,
  };
}
