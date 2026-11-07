/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';

/** Called ONLY from the registered tool after scheduler policy approval. */
export async function localWebSearch(
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const gateway = process.env['LOCAL_SEARCH_GATEWAY'];
  const key = process.env['TAVILY_API_KEY'];
  if (!gateway && !key)
    throw new Error('Tavily credential unavailable; search deferred');
  if (!query.trim() || query.length > 2000)
    throw new Error('Invalid search query');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  // A protected gateway owns quota/credentials for isolated workers. Standalone
  // use reserves quota durably before sending; failed/unknown sends still count.
  if (!gateway) {
    const path = process.env['TAVILY_QUOTA_FILE'];
    if (!path) throw new Error('Protected Tavily quota file required');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(path, {
      realpath: false,
      retries: 0,
      stale: 30000,
    });
    try {
      const month = new Date().toISOString().slice(0, 7);
      let previous: { month: string; searches: number };
      try {
        previous = z
          .object({
            month: z.string().regex(/^\d{4}-\d{2}$/),
            searches: z.number().int().nonnegative(),
          })
          .parse(JSON.parse(readFileSync(path, 'utf8')));
      } catch (e) {
        if (!(e instanceof Error) || !('code' in e) || e.code !== 'ENOENT')
          throw e;
        previous = { month, searches: 0 };
      }
      if (!Number.isSafeInteger(previous.searches) || previous.searches < 0)
        throw new Error('Corrupt quota');
      const searches = previous.month === month ? previous.searches : 0;
      if (searches >= 1000) throw new Error('Tavily monthly quota exhausted');
      const tmp = path + '.' + process.pid + '.tmp';
      writeFileSync(tmp, JSON.stringify({ month, searches: searches + 1 }), {
        mode: 0o600,
      });
      const fd = openSync(tmp, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      const parent = openSync(dirname(path), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      await release();
    }
  }
  const response = await fetch(gateway ?? 'https://api.tavily.com/search', {
    method: 'POST',
    signal: deadline,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(gateway ? {} : { api_key: key }),
      query,
      search_depth: 'basic',
      include_answer: false,
      max_results: 3,
    }),
  });
  if (!response.ok) throw new Error(`Search HTTP ${response.status}`);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 100000)
    throw new Error('Search response too large');
  const body = z
    .object({
      results: z.array(
        z.object({ url: z.string(), title: z.string(), content: z.string() }),
      ),
    })
    .parse(JSON.parse(raw));
  if (!Array.isArray(body.results)) throw new Error('Invalid search response');
  return JSON.stringify({
    provider: 'tavily',
    query,
    results: body.results
      .slice(0, 3)
      .map((r: { url: string; title: string; content: string }) => {
        const url = new URL(r.url);
        if (!['http:', 'https:'].includes(url.protocol))
          throw new Error('Invalid source URL');
        return {
          url: url.href,
          title: String(r.title).slice(0, 300),
          content: String(r.content).slice(0, 2500),
        };
      }),
  });
}
