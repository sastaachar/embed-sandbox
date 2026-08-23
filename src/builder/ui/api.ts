import type { Doc, Page, ProjectConfig } from './types';

/**
 * The whole editing API: read the document, write the document. Everything the
 * builder does — a moved block, a renamed site, a new page, a cluster login — is
 * the same PUT.
 */

export const PID: string = (window as any).__PID;
const BASE = `/api/projects/${PID}`;

let token = '';
export function setToken(t: string) { token = t; }
export function getToken() { return token; }

function authH(extra?: Record<string, string>) {
  return { authorization: `Bearer ${token}`, ...(extra || {}) };
}

export async function verifyToken(candidate: string): Promise<boolean> {
  const res = await fetch(`${BASE}/verify`, {
    method: 'POST', headers: { authorization: `Bearer ${candidate}` },
  });
  return res.ok;
}

export async function loadDoc(): Promise<Doc> {
  const res = await fetch(`${BASE}/config`);
  if (!res.ok) throw new Error('could not load this project');
  const doc = (await res.json()) as Doc;
  if (!doc.pages) doc.pages = {};
  return doc;
}

export interface EditLock { holder: string; note?: string; at: number; expiresAt: number }

export async function projectVersion(): Promise<{ updatedAt: number; lock: EditLock | null } | null> {
  const res = await fetch(`${BASE}/version`, { cache: 'no-store' });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body && typeof body.updatedAt === 'number'
    ? { updatedAt: body.updatedAt, lock: (body.lock as EditLock | null) ?? null }
    : null;
}

export interface SaveExtras {
}

export async function saveDoc(
  config: ProjectConfig,
  pages: Record<string, Page>,
  extra?: SaveExtras,
): Promise<Doc> {
  const res = await fetch(`${BASE}/config`, {
    method: 'PUT',
    headers: authH({ 'content-type': 'application/json' }),
    body: JSON.stringify({ config, pages, ...(extra || {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !(body as any).ok) throw new Error((body as any).error || 'save failed');
  return body as Doc;
}

export interface MetadataItem { id: string; name: string }

