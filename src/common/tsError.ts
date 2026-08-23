/**
 * The token API buries its human message three levels deep and double-encodes it:
 *
 *   { error: { message: { debug: { code, incident_id_guid,
 *       debug: "[\"Invalid parameter values: {\\\"username\\\":\\\"Specified user does not exist.\\\"}\"]" } } } }
 *
 * This digs it out — "Invalid parameter values — username: Specified user does not
 * exist. (incident 505acd96)" — and returns null when the shape is anything else, so
 * callers can fall back to the raw body.
 */
export function tokenApiMessage(raw: unknown): string | null {
  try {
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    let msg = (body as any)?.error?.message;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch { return msg; }
    }
    const dbg = msg?.debug;
    const incident = dbg && typeof dbg === 'object' && dbg.incident_id_guid
      ? String(dbg.incident_id_guid).slice(0, 8)
      : null;
    let text: unknown = typeof dbg === 'string' ? dbg : dbg?.debug;
    if (typeof text === 'string') {
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr) && arr.length) text = arr.map(String).join('; ');
      } catch { /* not an encoded array — keep as is */ }
    }
    if (typeof text !== 'string' || !text.trim()) return null;
    // "Invalid parameter values: {"username":"Specified user does not exist."}"
    const m = text.match(/^([^:{]+):\s*(\{[\s\S]*\})\s*$/);
    if (m) {
      try {
        const fields = JSON.parse(m[2]) as Record<string, unknown>;
        const parts = Object.entries(fields).map(([k, v]) => `${k}: ${String(v)}`);
        if (parts.length) text = `${m[1].trim()} — ${parts.join('; ')}`;
      } catch { /* inner blob was not JSON — keep the outer text */ }
    }
    return incident ? `${text} (incident ${incident})` : (text as string);
  } catch {
    return null;
  }
}
