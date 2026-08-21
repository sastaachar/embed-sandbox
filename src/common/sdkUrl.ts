/**
 * The one place that turns an SDK version into a CDN URL. Shared by the live shell
 * (preload + manifest), the code generator, and the worker's manifest endpoint, so a
 * change to how we pin the SDK lands everywhere at once.
 */
export const SDK_CDN_ORIGIN = 'https://cdn.jsdelivr.net';

export function sdkUrl(version: string | undefined): string {
  const v = version && version.length > 0 ? version : 'latest';
  return `${SDK_CDN_ORIGIN}/npm/@thoughtspot/visual-embed-sdk@${v}/dist/tsembed.js`;
}
