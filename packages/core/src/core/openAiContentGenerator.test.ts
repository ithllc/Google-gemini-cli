/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiContentGenerator } from './openAiContentGenerator.js';

describe('OpenAiContentGenerator tool mapping', () => {
  afterEach(() => {
    delete process.env['GEMINI_DISABLE_TOOLS'];
    vi.restoreAllMocks();
  });

  it('does not inject internal tools when request has no tools', () => {
    const generator = new OpenAiContentGenerator('http://localhost:4000/v1', 'test-key');

    const mapped = (generator as any).scrubAndMapTools({});

    expect(mapped).toBeUndefined();
  });

  it('maps and deduplicates function declarations by name', () => {
    const generator = new OpenAiContentGenerator('http://localhost:4000/v1', 'test-key');

    const mapped = (generator as any).scrubAndMapTools({
      tools: [
        {
          functionDeclarations: [
            {
              name: 'list_directory',
              description: 'List files',
              parametersJsonSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
              },
            },
            {
              name: 'list_directory',
              description: 'Duplicate should be dropped',
              parametersJsonSchema: {
                type: 'object',
                properties: { cwd: { type: 'string' } },
              },
            },
          ],
        },
      ],
    });

    expect(mapped).toHaveLength(1);
    expect(mapped?.[0]?.function?.name).toBe('list_directory');
  });

  it('adds google_search/code_execution bridges only when requested and dedupes them', () => {
    const generator = new OpenAiContentGenerator('http://localhost:4000/v1', 'test-key');

    const mapped = (generator as any).scrubAndMapTools({
      tools: [
        { googleSearch: {} },
        { codeExecution: {} },
        { googleSearch: {} },
      ],
    });

    expect(mapped?.map((t: any) => t.function.name).sort()).toEqual([
      'execute_python_code',
      'google_web_search',
    ]);
  });

  it('returns undefined when GEMINI_DISABLE_TOOLS is true', () => {
    process.env['GEMINI_DISABLE_TOOLS'] = 'true';
    const generator = new OpenAiContentGenerator('http://localhost:4000/v1', 'test-key');

    const mapped = (generator as any).scrubAndMapTools({
      tools: [{ functionDeclarations: [{ name: 'list_directory' }] }],
    });

    expect(mapped).toBeUndefined();
  });
});
