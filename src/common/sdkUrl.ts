/**
 * The one place that turns an SDK version into a script URL. Shared by the live shell
 * (preload + manifest), the code generator, and the worker's manifest endpoint, so a
 * change to how we pin the SDK lands everywhere at once.
 */
export const SDK_CDN_ORIGIN = 'https://cdn.jsdelivr.net';

/** Continuous releases: every PR and commit of the SDK is published as a tarball. */
export const PKG_PR_NEW_HOST = 'pkg.pr.new';

/** `pr:641` (a PR, moves with each commit) or `pr:ea75b98` (one commit, immutable). */
export function prRef(version: string | undefined): string | null {
  const m = /^pr:([A-Za-z0-9._-]{1,64})$/.exec((version ?? '').trim());
  return m ? m[1] : null;
}

/**
 * The tarball a pr ref names. A bare number is a PR (pkg.pr.new keeps it pointed at the
 * PR's latest commit); anything else is treated as a commit ref, which needs the longer
 * repo-qualified form.
 */
export function prTarballUrl(ref: string): string {
  const pkg = '@thoughtspot/visual-embed-sdk';
  return /^\d+$/.test(ref)
    ? `https://${PKG_PR_NEW_HOST}/${pkg}@${ref}`
    : `https://${PKG_PR_NEW_HOST}/thoughtspot/visual-embed-sdk/${pkg}@${ref}`;
}

/**
 * A pr ref cannot be a script src — pkg.pr.new serves an npm tarball — so it points at
 * this site's own unwrapping proxy instead. Root-relative on purpose: the published page
 * and the builder are both same-origin. `origin` makes it absolute for generated code,
 * which gets pasted somewhere else entirely.
 */
export function sdkUrl(version: string | undefined, origin = ''): string {
  const ref = prRef(version);
  if (ref) return `${origin}/sdk/pr/${ref}/tsembed.js`;
  const v = version && version.length > 0 ? version : 'latest';
  return `${SDK_CDN_ORIGIN}/npm/@thoughtspot/visual-embed-sdk@${v}/dist/tsembed.js`;
}

/** What to type into package.json for this pin — the install spec, not the script URL. */
export function sdkInstallSpec(version: string | undefined): string {
  const ref = prRef(version);
  if (ref) return `@thoughtspot/visual-embed-sdk@${prTarballUrl(ref)}`;
  return `@thoughtspot/visual-embed-sdk@${version && version.length ? version : 'latest'}`;
}
