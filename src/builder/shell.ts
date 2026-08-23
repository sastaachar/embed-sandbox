/**
 * The builder is a React app bundled to /_static/builder/builder.js by `npm run build:ui`.
 * This file only serves its shell: nothing about the UI lives here, so the page can
 * never drift from the components the way an inline template literal did.
 *
 * Bumped when the bundle changes so a stale copy is never served from cache.
 */
export const BUILDER_VERSION = '5';

const SORTABLE = 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.7/Sortable.min.js';
const INTERACT = 'https://cdn.jsdelivr.net/npm/interactjs@1.10.27/dist/interact.min.js';

export function renderBuilder(projectId: string, sdkUrl: string): string {
  const id = JSON.stringify(projectId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Build · ${projectId}</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="/_static/builder/builder.css?v=${BUILDER_VERSION}">
<script>window.__PID = ${id};</script>
</head>
<body>
<div id="root"></div>
<!-- At the end of body on purpose: interact.js binds its pointer handling at load
     time, and loading it before <body> exists leaves it deaf to every event. -->
<script src="${sdkUrl}"></script>
<script src="${SORTABLE}"></script>
<script src="${INTERACT}"></script>
<script src="/_static/builder/builder.js?v=${BUILDER_VERSION}"></script>
</body>
</html>`;
}
