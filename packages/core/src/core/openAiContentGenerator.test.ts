/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiContentGenerator } from './openAiContentGenerator.js';
import type OpenAI from 'openai';
import { LlmRole } from '../telemetry/llmRole.js';

const model = 'google/gemma-4-26b';
function completion(
  message: Partial<OpenAI.ChatCompletionMessage>,
): OpenAI.ChatCompletion {
  return {
    id: 'fixture',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          ...message,
        },
      },
    ],
  };
}
function setup(count = 100) {
  vi.stubEnv('LOCAL_LLM_MODEL', model);
  vi.stubEnv('LOCAL_LLM_CONTEXT_CAP', '10000');
  vi.stubEnv('LOCAL_LLM_CONTEXT_SAFETY', '100');
  const fetcher = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/models')
        ? { data: [{ id: model, max_model_len: 12000 }] }
        : { count },
  }));
  vi.stubGlobal('fetch', fetcher);
  const g = new OpenAiContentGenerator('http://localhost:1234/v1');
  const create = vi.fn(async (_payload: unknown, _options: unknown) => ({
    model,
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: count,
      completion_tokens: 1,
      total_tokens: count + 1,
    },
  }));
  vi.spyOn(g['openai'].chat.completions, 'create').mockImplementation(
    create as never,
  );
  return { g, create, fetcher };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('bounded local adapter', () => {
  it.each([
    'protected',
    { text: 'protected' },
    { parts: [{ text: 'protected' }] },
    ['protected'],
  ])(
    'preserves actual config.systemInstruction form %j and pins helper route',
    async (instruction) => {
      const { g, create } = setup();
      await g.generateContent(
        {
          model: 'gemini-helper',
          contents: 'task',
          config: { systemInstruction: instruction },
        } as never,
        'p',
        LlmRole.MAIN,
      );
      expect(create.mock.calls[0][0]).toMatchObject({
        model,
        messages: [
          { role: 'system', content: 'protected' },
          { role: 'user', content: 'task' },
        ],
        max_tokens: 2048,
      });
    },
  );
  it('round trips mixed calls and repeated names with original IDs, without executing any', () => {
    const { g, create } = setup();
    const calls = ['google_web_search', 'read_file', 'read_file'].map(
      (name, i) => ({
        id: `id-${i}`,
        type: 'function' as const,
        function: { name, arguments: '{}' },
      }),
    );
    const mapped = g['mapOpenAIToGemini'](completion({ tool_calls: calls }));
    expect(
      mapped.functionCalls!.map((c: { id?: string; name?: string }) => c.id),
    ).toEqual(['id-0', 'id-1', 'id-2']);
    const messages = g['mapGeminiToOpenAI']({
      model,
      contents: [
        mapped.candidates![0].content!,
        {
          role: 'user',
          parts: mapped.functionCalls!.map(
            (c: { id?: string; name?: string }) => ({
              functionResponse: {
                id: c.id,
                name: c.name,
                response: { output: 'ok' },
              },
            }),
          ),
        },
      ],
    });
    expect(
      messages.slice(1).map((m: Record<string, unknown>) => m['tool_call_id']),
    ).toEqual(['id-0', 'id-1', 'id-2']);
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    [3852, 'ROTATE'],
    [5000, 'REJECT'],
    [0, 'count unavailable'],
  ])('blocks count %i before completion', async (count, reason) => {
    const { g, create } = setup(count);
    await expect(
      g.generateContent({ model, contents: 'task' }, 'p', LlmRole.MAIN),
    ).rejects.toThrow(reason);
    expect(create).not.toHaveBeenCalled();
  });
  it('counts tools and output on the actual payload and carries abort signal', async () => {
    const { g, create, fetcher } = setup();
    await g.generateContent(
      {
        model,
        contents: 'task',
        config: {
          maxOutputTokens: 500,
          tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
        },
      },
      'p',
      LlmRole.MAIN,
    );
    expect(
      JSON.parse(
        (fetcher.mock.calls[1] as unknown as [string, { body: string }])[1]
          .body,
      ).tools[0].function.name,
    ).toBe('read_file');
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 500 });
    expect(
      (create.mock.calls[0][1] as { signal: AbortSignal }).signal,
    ).toBeInstanceOf(AbortSignal);
  });
  it('rejects unsupported native execution and headless question/delegation tools', () => {
    const { g } = setup();
    expect(() =>
      g['scrubAndMapTools']({ tools: [{ codeExecution: {} }] }),
    ).toThrow('disabled');
    expect(
      g['scrubAndMapTools']({
        tools: [
          {
            functionDeclarations: [
              { name: 'ask_user' },
              { name: 'invoke_agent' },
              { name: 'read_file' },
            ],
          },
        ],
      }),
    ).toHaveLength(1);
    expect(() =>
      g['mapOpenAIToGemini'](
        completion({
          tool_calls: [
            {
              id: 'x',
              type: 'function',
              function: { name: 'ask_user', arguments: '{}' },
            },
          ],
        }),
      ),
    ).toThrow('denied');
  });
  it('fails on unavailable capacity, embeddings, unmatched call IDs and model drift', async () => {
    const { g, create } = setup();
    await expect(g.embedContent({} as never)).rejects.toThrow('not qualified');
    expect(() =>
      g['mapGeminiToOpenAI']({
        model,
        contents: [
          {
            parts: [{ functionResponse: { id: 'missing', name: 'read_file' } }],
          },
        ],
      }),
    ).toThrow('Unmatched');
    create.mockResolvedValueOnce({ model: 'different', choices: [] } as never);
    await expect(
      g.generateContent({ model, contents: 'task' }, 'p', LlmRole.MAIN),
    ).rejects.toThrow('identity changed');
    vi.stubEnv('LOCAL_LLM_MODEL', '');
    await expect(g.countTokens({ model, contents: 'task' })).rejects.toThrow(
      'required',
    );
  });
  it('uses a real count, no hidden retries, and rejects multimodal inputs', async () => {
    const { g, create } = setup(42);
    expect(await g.countTokens({ model, contents: 'hello' })).toEqual({
      totalTokens: 42,
    });
    create.mockRejectedValueOnce(new Error('failed'));
    await expect(
      g.generateContent({ model, contents: 'task' }, 'p', LlmRole.MAIN),
    ).rejects.toThrow('failed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(() =>
      g['mapGeminiToOpenAI']({
        model,
        contents: [{ parts: [{ inlineData: { data: 'a' } }] }],
      }),
    ).toThrow('multimodal');
  });
});
