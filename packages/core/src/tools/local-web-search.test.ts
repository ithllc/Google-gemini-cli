/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localWebSearch } from './local-web-search.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'search252-'));
  roots.push(dir);
  const path = join(dir, 'quota.json');
  vi.stubEnv('LOCAL_SEARCH_GATEWAY', '');
  vi.stubEnv('TAVILY_API_KEY', 'test-placeholder');
  vi.stubEnv('TAVILY_QUOTA_FILE', path);
  const fetcher = vi.fn(async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        results: [
          {
            url: 'https://example.com/docs',
            title: 'docs',
            content: 'evidence',
          },
        ],
      }),
  }));
  vi.stubGlobal('fetch', fetcher);
  return { path, fetcher };
}
describe('registered Tavily search', () => {
  it('requires provisioned credential and never uses an embedded fallback', async () => {
    setup();
    vi.stubEnv('TAVILY_API_KEY', '');
    await expect(
      localWebSearch('query', new AbortController().signal),
    ).rejects.toThrow('credential unavailable');
  });
  it('durably reserves quota, resets month and preserves source URLs', async () => {
    const { path, fetcher } = setup();
    writeFileSync(path, JSON.stringify({ month: '2000-01', searches: 1000 }));
    const result = JSON.parse(
      await localWebSearch('query', new AbortController().signal),
    );
    expect(result.results[0].url).toBe('https://example.com/docs');
    expect(JSON.parse(readFileSync(path, 'utf8')).searches).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not overspend exhausted or concurrently reserved quota', async () => {
    const { path, fetcher } = setup();
    writeFileSync(
      path,
      JSON.stringify({
        month: new Date().toISOString().slice(0, 7),
        searches: 999,
      }),
    );
    const results = await Promise.allSettled([
      localWebSearch('one', new AbortController().signal),
      localWebSearch('two', new AbortController().signal),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(
      localWebSearch('three', new AbortController().signal),
    ).rejects.toThrow('quota exhausted');
  });
  it('rejects provider errors and corrupt counters without resetting them', async () => {
    const { path, fetcher } = setup();
    fetcher.mockResolvedValueOnce({ ok: false, status: 429 } as never);
    await expect(
      localWebSearch('query', new AbortController().signal),
    ).rejects.toThrow('429');
    expect(JSON.parse(readFileSync(path, 'utf8')).searches).toBe(1);
    writeFileSync(path, 'broken');
    await expect(
      localWebSearch('query', new AbortController().signal),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
