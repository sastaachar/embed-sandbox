import {
  DEFAULT_PROJECT,
  STARTER_PAGE,
  normalizeStoredPage,
  normalizeStoredProject,
  type PageConfig,
  type ProjectConfig,
} from './schema';

export interface Env {
  DB: D1Database;
}

/** Design-time cluster connection. The secret is never part of this. */
export interface Connection {
  host: string;
  username: string;
  secretType: 'password' | 'secret_key';
  verifiedAt: number | null;
  /** True when a secret is stored server-side; the secret itself is never returned here. */
  hasSecret: boolean;
}

export interface Project {
  id: string;
  config: ProjectConfig;
  createdAt: number;
  updatedAt: number;
  forkedFrom: string | null;
  /** Server-only cluster connection (never shipped to the page). null if none set. */
  connection: Connection | null;
  /** Advisory edit lock (an agent announcing itself). null when unheld or expired. */
  lock: EditLock | null;
}

export interface EditLock {
  holder: string;
  note?: string;
  at: number;
  expiresAt: number;
}

/** Advisory only — nothing is blocked. Expiry means a dead agent cannot wedge a demo. */
export const LOCK_TTL_MS = 5 * 60_000;

export interface Page {
  path: string;
  config: PageConfig;
  updatedAt: number;
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function newProjectId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createProject(
  env: Env,
  config: ProjectConfig,
): Promise<{ project: Project; token: string }> {
  const id = newProjectId();
  const token = newToken();
  const tokenHash = await hashToken(token);
  const now = Date.now();
  const merged: ProjectConfig = { ...DEFAULT_PROJECT, ...config };

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO projects (id, token_hash, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(id, tokenHash, JSON.stringify(merged), now, now),
    env.DB.prepare(
      'INSERT INTO pages (project_id, path, config, updated_at) VALUES (?, ?, ?, ?)',
    ).bind(id, '/', JSON.stringify(STARTER_PAGE), now),
  ]);

  return {
    project: { id, config: merged, createdAt: now, updatedAt: now, forkedFrom: null, connection: null, lock: null },
    token,
  };
}

export async function getProject(env: Env, id: string): Promise<Project | null> {
  // conn_secret is deliberately NOT selected here: getProject feeds public
  // responses and the page manifest. Reading the secret has its own function.
  const row = await env.DB.prepare(
    `SELECT id, config, created_at, updated_at, forked_from,
            conn_host, conn_username, conn_secret_type, conn_verified_at,
            conn_secret IS NOT NULL AS has_secret,
            lock_holder, lock_note, lock_at
     FROM projects WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      config: string;
      created_at: number;
      updated_at: number;
      forked_from: string | null;
      conn_host: string | null;
      conn_username: string | null;
      conn_secret_type: string | null;
      conn_verified_at: number | null;
      has_secret: number;
      lock_holder: string | null;
      lock_note: string | null;
      lock_at: number | null;
    }>();
  if (!row) return null;
  const lock: EditLock | null =
    row.lock_holder && row.lock_at && Date.now() - row.lock_at < LOCK_TTL_MS
      ? {
          holder: row.lock_holder,
          ...(row.lock_note ? { note: row.lock_note } : {}),
          at: row.lock_at,
          expiresAt: row.lock_at + LOCK_TTL_MS,
        }
      : null;
  const connection: Connection | null = row.conn_host
    ? {
        host: row.conn_host,
        username: row.conn_username ?? '',
        secretType: row.conn_secret_type === 'secret_key' ? 'secret_key' : 'password',
        verifiedAt: row.conn_verified_at ?? null,
        hasSecret: !!row.has_secret,
      }
    : null;
  return {
    id: row.id,
    config: normalizeStoredProject(JSON.parse(row.config) as ProjectConfig),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forkedFrom: row.forked_from ?? null,
    connection,
    lock,
  };
}

export async function setLock(env: Env, id: string, holder: string, note?: string): Promise<EditLock> {
  const at = Date.now();
  await env.DB.prepare('UPDATE projects SET lock_holder = ?, lock_note = ?, lock_at = ? WHERE id = ?')
    .bind(holder, note ?? null, at, id)
    .run();
  return { holder, ...(note ? { note } : {}), at, expiresAt: at + LOCK_TTL_MS };
}

export async function clearLock(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE projects SET lock_holder = NULL, lock_note = NULL, lock_at = NULL WHERE id = ?')
    .bind(id)
    .run();
}

/** Keeps a held lock alive on agent activity; a no-op when nothing is held. */
export async function refreshLock(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE projects SET lock_at = ? WHERE id = ? AND lock_holder IS NOT NULL')
    .bind(Date.now(), id)
    .run();
}

/**
 * Writes the design-time cluster connection: host, username and the secret, server-side
 * only. The secret is stored here and NEVER echoed back to a client or shipped in the
 * page — search_metadata and the builder read it through getConnectionSecret.
 */
export async function setConnection(
  env: Env,
  projectId: string,
  conn: { host: string; username: string; secret: string; secretType: 'password' | 'secret_key' },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE projects SET conn_host = ?, conn_username = ?, conn_secret = ?,
            conn_secret_type = ?, conn_verified_at = ? WHERE id = ?`,
  )
    .bind(conn.host, conn.username, conn.secret, conn.secretType, Date.now(), projectId)
    .run();
}

/** The one place the connection secret is read, for a server-side token mint. */
export async function getConnectionSecret(
  env: Env,
  projectId: string,
): Promise<{ host: string; username: string; secret: string; secretType: 'password' | 'secret_key' } | null> {
  const row = await env.DB.prepare(
    'SELECT conn_host, conn_username, conn_secret, conn_secret_type FROM projects WHERE id = ?',
  )
    .bind(projectId)
    .first<{ conn_host: string | null; conn_username: string | null; conn_secret: string | null; conn_secret_type: string | null }>();
  if (!row || !row.conn_host || !row.conn_secret) return null;
  return {
    host: row.conn_host,
    username: row.conn_username ?? '',
    secret: row.conn_secret,
    secretType: row.conn_secret_type === 'secret_key' ? 'secret_key' : 'password',
  };
}

/**
 * Copies site config and every page into a brand-new project with its own edit
 * token. Public on purpose: the source's token is not required, because forking
 * only ever reads data that is already publicly readable at /p/<id>/.
 */
export async function forkProject(
  env: Env,
  sourceId: string,
): Promise<{ project: Project; token: string; copiedPages: number } | null> {
  const source = await getProject(env, sourceId);
  if (!source) return null;
  const pages = await listPages(env, sourceId);

  const id = newProjectId();
  const token = newToken();
  const tokenHash = await hashToken(token);
  const now = Date.now();
  const config: ProjectConfig = { ...source.config };
  config.name = (source.config.name || 'Embed sandbox') + ' (fork)';

  const statements = [
    env.DB.prepare(
      `INSERT INTO projects (id, token_hash, config, created_at, updated_at, forked_from)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, tokenHash, JSON.stringify(config), now, now, sourceId),
  ];
  for (const page of pages) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO pages (project_id, path, config, updated_at) VALUES (?, ?, ?, ?)',
      ).bind(id, page.path, JSON.stringify(page.config), now),
    );
  }
  await env.DB.batch(statements);

  // The fork deliberately gets no connection: credentials are not copyable.
  return {
    project: { id, config, createdAt: now, updatedAt: now, forkedFrom: sourceId, connection: null, lock: null },
    token,
    copiedPages: pages.length,
  };
}

/**
 * Deletes a project and everything under it. Pages go first and explicitly: the FK
 * cascade is there, but D1 does not promise foreign keys are enforced on every
 * database, and an orphaned page row would be served by nothing and deletable by
 * nobody. The connection secret and the lock are columns on the row, so they go with it.
 */
export async function deleteProject(
  env: Env,
  id: string,
): Promise<{ deleted: boolean; deletedPages: number }> {
  const pages = await env.DB.prepare('DELETE FROM pages WHERE project_id = ?').bind(id).run();
  const project = await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
  return {
    deleted: (project.meta.changes ?? 0) > 0,
    deletedPages: pages.meta.changes ?? 0,
  };
}

/**
 * Issue a new edit token and forget the old one. Every holder of the old token loses access
 * at once: other browsers, any MCP connector it was pasted into, a link that still carries
 * it in its fragment. That is the point of rotating, so the caller has to say so.
 */
export async function rotateToken(env: Env, id: string): Promise<string | null> {
  const token = newToken();
  const res = await env.DB.prepare('UPDATE projects SET token_hash = ? WHERE id = ?')
    .bind(await hashToken(token), id)
    .run();
  const changed = (res.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changed > 0 ? token : null;
}

export async function verifyToken(env: Env, id: string, token: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT token_hash FROM projects WHERE id = ?')
    .bind(id)
    .first<{ token_hash: string }>();
  if (!row) return false;
  return constantTimeEquals(row.token_hash, await hashToken(token));
}

export async function updateProjectConfig(
  env: Env,
  id: string,
  patch: ProjectConfig,
): Promise<Project | null> {
  const existing = await getProject(env, id);
  if (!existing) return null;
  const merged: ProjectConfig = {
    ...existing.config,
    ...patch,
    theme: { ...existing.config.theme, ...patch.theme },
    header: patch.header ? { ...existing.config.header, ...patch.header } : existing.config.header,
    footer: patch.footer ? { ...existing.config.footer, ...patch.footer } : existing.config.footer,
    embedDefaults: patch.embedDefaults
      ? { ...existing.config.embedDefaults, ...patch.embedDefaults }
      : existing.config.embedDefaults,
  };
  const now = Date.now();
  await env.DB.prepare('UPDATE projects SET config = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(merged), now, id)
    .run();
  return { ...existing, config: merged, updatedAt: now };
}

/** Whole-document save: the config is replaced, not merged. */
export async function setProjectConfig(
  env: Env,
  id: string,
  config: ProjectConfig,
): Promise<number> {
  const now = Date.now();
  await env.DB.prepare('UPDATE projects SET config = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(config), now, id)
    .run();
  return now;
}

export async function listPages(env: Env, projectId: string): Promise<Page[]> {
  const { results } = await env.DB.prepare(
    'SELECT path, config, updated_at FROM pages WHERE project_id = ? ORDER BY path',
  )
    .bind(projectId)
    .all<{ path: string; config: string; updated_at: number }>();
  return (results ?? []).map((row) => ({
    path: row.path,
    config: normalizeStoredPage(JSON.parse(row.config) as PageConfig),
    updatedAt: row.updated_at,
  }));
}

export async function getPage(env: Env, projectId: string, path: string): Promise<Page | null> {
  const row = await env.DB.prepare(
    'SELECT path, config, updated_at FROM pages WHERE project_id = ? AND path = ?',
  )
    .bind(projectId, path)
    .first<{ path: string; config: string; updated_at: number }>();
  if (!row) return null;
  return {
    path: row.path,
    config: normalizeStoredPage(JSON.parse(row.config) as PageConfig),
    updatedAt: row.updated_at,
  };
}

export async function putPage(
  env: Env,
  projectId: string,
  path: string,
  config: PageConfig,
): Promise<Page> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pages (project_id, path, config, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, path) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    ).bind(projectId, path, JSON.stringify(config), now),
    env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, projectId),
  ]);
  return { path, config, updatedAt: now };
}

export async function deletePage(env: Env, projectId: string, path: string): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.prepare('DELETE FROM pages WHERE project_id = ? AND path = ?')
    .bind(projectId, path)
    .run();
  await env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, projectId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function countPages(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM pages WHERE project_id = ?')
    .bind(projectId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
