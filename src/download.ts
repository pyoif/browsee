/**
 * Dependency-free download helpers on top of Node's built-in fetch (undici).
 * Progress is reported through a callback so callers can route it to stderr
 * (stdout is reserved for the JSON-RPC channel).
 */

export interface DownloadResult {
  bytes: number;
  source: string;
}

export function logStderr(msg: string): void {
  process.stderr.write(`browsee: ${msg}\n`);
}

/**
 * Download `url` to an in-memory Buffer, following redirects (fetch does this
 * by default), with a per-request timeout. Retries each candidate URL in order
 * until one succeeds, so callers can pass CDN mirrors.
 */
export async function downloadToBuffer(
  urls: string[],
  opts: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    label?: string;
  } = {},
): Promise<{ buffer: Buffer; source: string }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const label = opts.label ?? "file";
  const errors: string[] = [];

  for (const url of urls) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      logStderr(`downloading ${label} from ${url}`);
      const init: RequestInit = { redirect: "follow", signal: ac.signal };
      if (opts.headers) init.headers = opts.headers;
      const res = await fetch(url, init);
      if (!res.ok) {
        errors.push(`${url} -> HTTP ${res.status}`);
        clearTimeout(timer);
        continue;
      }
      const ab = await res.arrayBuffer();
      const buffer = Buffer.from(ab);
      if (buffer.length === 0) {
        errors.push(`${url} -> empty body`);
        clearTimeout(timer);
        continue;
      }
      clearTimeout(timer);
      logStderr(`downloaded ${label}: ${buffer.length} bytes`);
      return { buffer, source: url };
    } catch (err) {
      errors.push(`${url} -> ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`all download sources failed for ${label}:\n  ${errors.join("\n  ")}`);
}

/** Download text (small JSON/metadata files) with the same mirror-retry logic. */
export async function downloadText(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
  try {
    const init: RequestInit = { redirect: "follow", signal: ac.signal };
    if (opts.headers) init.headers = opts.headers;
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
