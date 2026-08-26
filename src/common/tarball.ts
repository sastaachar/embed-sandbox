/**
 * `npm i https://pkg.pr.new/@thoughtspot/visual-embed-sdk@641` fetches a tarball and
 * unpacks it. A browser cannot do that with a <script src>, so this does the same thing
 * server-side: fetch the tarball, gunzip it, and pull one file out.
 */

/** One file out of a POSIX tar, by exact name. npm tarballs prefix every path "package/". */
export function readTarFile(bytes: Uint8Array, want: string): Uint8Array | null {
  const text = (from: number, len: number) => {
    let out = '';
    for (let i = from; i < from + len; i += 1) {
      const c = bytes[i];
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  };

  let off = 0;
  while (off + 512 <= bytes.length) {
    const name = text(off, 100);
    if (!name) {
      // Two zero blocks end the archive; a single one is padding worth stepping over.
      off += 512;
      continue;
    }
    // Size is octal, space- or NUL-terminated.
    const size = parseInt(text(off + 124, 12).trim() || '0', 8) || 0;
    const data = off + 512;
    if (name === want) return bytes.subarray(data, data + size);
    off = data + Math.ceil(size / 512) * 512;
  }
  return null;
}

export class TarballError extends Error {}

/** Fetch a .tgz and return one member, or throw a message worth showing a human. */
export async function fileFromTarball(url: string, member: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/tar+gzip, application/octet-stream' } });
  } catch (err) {
    throw new TarballError(`could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    throw new TarballError(
      res.status === 404
        ? `${url} has no build — check the PR number or commit, and that its build finished`
        : `${url} returned ${res.status}`,
    );
  }
  let flat: Uint8Array;
  try {
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    flat = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    throw new TarballError(`that URL did not decompress as a tarball: ${(err as Error).message}`);
  }
  const found = readTarFile(flat, member);
  if (!found) throw new TarballError(`the tarball has no ${member}`);
  return found;
}
