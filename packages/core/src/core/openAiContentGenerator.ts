/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  FinishReason,
  type GenerateContentParameters,
  GenerateContentResponse,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type Part,
} from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import type { UserTierId } from '../code_assist/types.js';
import type { LlmRole } from '../telemetry/llmRole.js';

type Wire = Record<string, unknown>;
const digest = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
function integer(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function textParts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textParts).join('\n');
  if (isRecord(value)) {
    const item = value;
    if (item['parts'] !== undefined) return textParts(item['parts']);
    const text = item['text'];
    if (typeof text === 'string') return text;
  }
  throw new Error('Unsupported non-text local-model content');
}

/** A translation layer only: every tool goes through the ordinary CLI scheduler.
 * No adapter-side shell, Python, search execution, recursion or invisible retries.
 * /tokenize must apply the SAME served chat template (including tools) as inference.
 */
export class OpenAiContentGenerator implements ContentGenerator {
  private readonly openai: OpenAI;
  private readonly baseUrl: string;
  private readonly timeout = integer('LOCAL_LLM_TIMEOUT_MS', 45000);
  private readonly vendorDefaults: boolean;
  userTier?: UserTierId;
  userTierName?: string;
  constructor(baseUrl: string, apiKey?: string) {
    const policy = process.env['LLM_GENERATION_POLICY'] ?? 'local_bounded_v1';
    if (!['local_bounded_v1', 'vendor_defaults_v1'].includes(policy))
      throw new Error('Unknown LLM_GENERATION_POLICY');
    this.vendorDefaults = policy === 'vendor_defaults_v1';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.openai = new OpenAI({
      baseURL: this.baseUrl,
      apiKey: apiKey || 'local-no-secret',
      timeout: this.timeout,
      maxRetries: 0,
    });
  }
  private signal(signal?: AbortSignal): AbortSignal {
    const deadline = Number(process.env['LOCAL_LLM_DEADLINE_MS'] ?? Infinity);
    const remaining = Math.min(this.timeout, deadline - Date.now());
    if (!(remaining > 0)) throw new Error('LOCAL_DEADLINE_EXPIRED');
    const timeout = AbortSignal.timeout(Math.ceil(remaining));
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
  private async metadata(
    signal: AbortSignal,
  ): Promise<{ id: string; capacity: number }> {
    const response = await fetch(this.baseUrl + '/models', { signal });
    if (!response.ok) throw new Error(`Model metadata HTTP ${response.status}`);
    const body: unknown = await response.json();
    const models: unknown = Array.isArray(body)
      ? body
      : isRecord(body)
        ? (body['data'] ?? body['models'])
        : undefined;
    const pin = process.env['LOCAL_LLM_MODEL'];
    if (!pin || !Array.isArray(models))
      throw new Error('Verified LOCAL_LLM_MODEL required');
    const model: unknown = models.find(
      (m: unknown) => isRecord(m) && m['id'] === pin,
    );
    const capacity = Number(
      isRecord(model) ? model['max_model_len'] : undefined,
    );
    if (!model || !Number.isSafeInteger(capacity) || capacity <= 0)
      throw new Error('Verified served context capacity unavailable');
    return {
      id: pin,
      capacity: this.vendorDefaults
        ? capacity
        : Math.min(capacity, integer('LOCAL_LLM_CONTEXT_CAP', 32768)),
    };
  }
  private audit(record: Wire): void {
    // Metadata only: never store prompt, results, keys or raw provider errors.
    const path = process.env['LOCAL_LLM_AUDIT_FILE'];
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(
      path,
      JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n',
      { mode: 0o600 },
    );
  }
  private async measure(payload: Wire, signal: AbortSignal): Promise<number> {
    const url =
      process.env['LOCAL_LLM_TOKENIZE_URL'] ??
      this.baseUrl.replace(/\/v1$/, '') + '/tokenize';
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: payload['model'],
        messages: payload['messages'],
        tools: payload['tools'],
        chat_template_kwargs: payload['chat_template_kwargs'],
        add_generation_prompt: true,
      }),
    });
    if (!response.ok) throw new Error(`Tokenizer HTTP ${response.status}`);
    const body: unknown = await response.json();
    const count = isRecord(body) ? body['count'] : undefined;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0)
      throw new Error('Verified token count unavailable');
    return count;
  }
  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const signal = this.signal(request.config?.abortSignal);
    const model = await this.metadata(signal);
    // Pin ALL helper routes to the qualified model, not Gemini utility defaults.
    const output = this.vendorDefaults
      ? undefined
      : Math.min(
          request.config?.maxOutputTokens ??
            integer('LOCAL_LLM_MAX_OUTPUT', 2048),
          integer('LOCAL_LLM_MAX_OUTPUT', 2048),
        );
    if (
      !this.vendorDefaults &&
      (typeof output !== 'number' ||
        !Number.isSafeInteger(output) ||
        output <= 0)
    )
      throw new Error('Invalid output budget');
    const payload: Wire = {
      model: model.id,
      messages: this.mapGeminiToOpenAI(request),
      ...(!this.vendorDefaults
        ? {
            temperature: request.config?.temperature ?? 0,
            max_tokens: output,
          }
        : {}),
    };
    const thinking = process.env['LOCAL_LLM_DISABLE_THINKING'];
    if (!this.vendorDefaults && (thinking === 'true' || thinking === 'false'))
      payload['chat_template_kwargs'] = {
        enable_thinking: thinking === 'false',
      };
    const tools = this.scrubAndMapTools(request);
    if (tools) payload['tools'] = tools;
    if (request.config?.responseMimeType === 'application/json')
      payload['response_format'] = { type: 'json_object' };
    if (Buffer.byteLength(JSON.stringify(payload)) > 1048576)
      throw new Error('LOCAL_INPUT_BYTES_EXCEEDED');
    const input = await this.measure(payload, signal);
    const safety = this.vendorDefaults
      ? 0
      : integer('LOCAL_LLM_CONTEXT_SAFETY', 512);
    const projected = input + (output ?? 0) + safety;
    const decision = this.vendorDefaults
      ? input < model.capacity
        ? 'ADMIT'
        : 'REJECT'
      : projected > 0.7 * model.capacity
        ? 'REJECT'
        : projected >= 0.6 * model.capacity
          ? 'ROTATE'
          : 'ADMIT';
    this.audit({
      model: model.id,
      capacity: model.capacity,
      input,
      output,
      safety,
      decision,
      output_policy: this.vendorDefaults
        ? 'vendor_defaults_v1'
        : 'local_bounded_v1',
      request_digest: digest(payload),
    });
    if (decision !== 'ADMIT')
      throw new Error(
        this.vendorDefaults
          ? 'VENDOR_INPUT_EXCEEDS_SERVED_CONTEXT'
          : `LOCAL_CONTEXT_${decision}`,
      );
    const response = await this.openai.chat.completions.create(
      // Wire is constructed above from text messages and validated function declarations.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      payload as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      { signal, timeout: this.timeout },
    );
    if (response.model !== model.id)
      throw new Error('Served model identity changed');
    if (
      !this.vendorDefaults &&
      response.usage &&
      response.usage.prompt_tokens > input + safety
    )
      throw new Error('Provider token accounting discrepancy');
    this.audit({
      model: response.model,
      response_digest: digest(response),
      usage: response.usage,
    });
    return this.mapOpenAIToGemini(response);
  }
  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const response = await this.generateContent(request, userPromptId, role);
    return (async function* () {
      yield response;
    })();
  }
  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const signal = this.signal();
    const model = await this.metadata(signal);
    return {
      totalTokens: await this.measure(
        {
          model: model.id,
          messages: this.mapGeminiToOpenAI(
            request as GenerateContentParameters,
          ),
          tools: this.scrubAndMapTools(request),
          ...(!this.vendorDefaults &&
          ['true', 'false'].includes(
            process.env['LOCAL_LLM_DISABLE_THINKING'] ?? '',
          )
            ? {
                chat_template_kwargs: {
                  enable_thinking:
                    process.env['LOCAL_LLM_DISABLE_THINKING'] === 'false',
                },
              }
            : {}),
        },
        signal,
      ),
    };
  }
  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Local embeddings are not qualified');
  }
  private scrubAndMapTools(req: unknown): Wire[] | undefined {
    if (process.env['GEMINI_DISABLE_TOOLS'] === 'true') return undefined;
    if (!isRecord(req)) throw new Error('Invalid request');
    const config = req['config'];
    const inputTools =
      (isRecord(config) ? config['tools'] : undefined) ?? req['tools'] ?? [];
    if (!Array.isArray(inputTools)) throw new Error('Invalid tools');
    const result: Wire[] = [];
    const seen = new Set<string>();
    for (const rawTool of inputTools) {
      const tool: unknown = rawTool;
      if (!isRecord(tool)) throw new Error('Invalid tool schema');
      // Provider-native tools cannot bypass scheduler policy. Search is handled
      // inside the registered web-search tool; Python uses ordinary shell policy.
      if (
        tool['googleSearch'] !== undefined ||
        tool['codeExecution'] !== undefined
      )
        throw new Error(
          'Native provider tool disabled; use a registered scheduler tool',
        );
      const declarations = tool['functionDeclarations'] ?? [];
      if (!Array.isArray(declarations)) throw new Error('Invalid declarations');
      for (const rawFunction of declarations) {
        const fn: unknown = rawFunction;
        if (!isRecord(fn)) throw new Error('Invalid function schema');
        const name = String(fn['name']);
        if (
          [
            'ask_user',
            'invoke_agent',
            'activate_skill',
            'execute_python_code',
            'codeExecution',
          ].includes(name)
        )
          continue;
        if (seen.has(name)) continue;
        seen.add(name);
        result.push({
          type: 'function',
          function: {
            name,
            description: fn['description'] ?? '',
            parameters: fn['parametersJsonSchema'] ??
              fn['parameters'] ?? { type: 'object', properties: {} },
          },
        });
      }
    }
    return result.length ? result : undefined;
  }
  private mapGeminiToOpenAI(req: GenerateContentParameters): Wire[] {
    const messages: Wire[] = [];
    const protectedFile = process.env['LOCAL_LLM_PROTECTED_FILE'];
    if (protectedFile) {
      const protectedText = readFileSync(protectedFile, 'utf8');
      if (!protectedText.trim() || Buffer.byteLength(protectedText) > 32768)
        throw new Error('Invalid protected instruction block');
      messages.push({ role: 'system', content: protectedText });
    }
    const system =
      req.config?.systemInstruction ??
      ('systemInstruction' in req ? req.systemInstruction : undefined);
    if (system !== undefined)
      messages.push({ role: 'system', content: textParts(system) });
    const input = Array.isArray(req.contents) ? req.contents : [req.contents];
    const pending = new Map<string, string>();
    for (const content of input) {
      if (typeof content === 'string') {
        messages.push({ role: 'user', content });
        continue;
      }
      if (!content) continue;
      const c = content as { role?: string; parts?: Part[]; text?: string };
      const parts = c.parts ?? (c.text !== undefined ? [{ text: c.text }] : []);
      const calls: Wire[] = [];
      const texts: string[] = [];
      for (const part of parts) {
        if (part.functionCall) {
          const f = part.functionCall;
          if (!f.id || !f.name || pending.has(f.id))
            throw new Error('Missing or duplicate tool identity');
          pending.set(f.id, f.name);
          calls.push({
            id: f.id,
            type: 'function',
            function: { name: f.name, arguments: JSON.stringify(f.args ?? {}) },
          });
        } else if (part.functionResponse) {
          const f = part.functionResponse;
          if (!f.id || pending.get(f.id) !== f.name)
            throw new Error('Unmatched tool response identity');
          pending.delete(f.id);
          messages.push({
            role: 'tool',
            tool_call_id: f.id,
            content: JSON.stringify(f.response),
          });
        } else if (part.text !== undefined) texts.push(part.text);
        else throw new Error('Unqualified multimodal local-model input');
      }
      if (texts.length || calls.length)
        messages.push({
          role: c.role === 'model' ? 'assistant' : 'user',
          content: texts.join('\n') || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
    }
    if (pending.size)
      throw new Error('Unresolved tool calls before model request');
    return messages;
  }
  private mapOpenAIToGemini(
    response: OpenAI.ChatCompletion,
  ): GenerateContentResponse {
    const choice = response.choices[0];
    if (!choice) throw new Error('Missing completion choice');
    const parts: Part[] = [];
    if (choice.message.content) parts.push({ text: choice.message.content });
    const ids = new Set<string>();
    for (const call of choice.message.tool_calls ?? []) {
      if (call.type !== 'function' || !call.id || ids.has(call.id))
        throw new Error('Invalid backend tool identity');
      ids.add(call.id);
      const args: unknown = JSON.parse(call.function.arguments || '{}');
      if (!isRecord(args)) throw new Error('Invalid tool arguments');
      if (
        [
          'ask_user',
          'invoke_agent',
          'activate_skill',
          'execute_python_code',
          'codeExecution',
        ].includes(call.function.name)
      )
        throw new Error('Noninteractive policy denied tool');
      parts.push({
        functionCall: { id: call.id, name: call.function.name, args },
      });
    }
    if (!parts.length) parts.push({ text: '' });
    const mapped = new GenerateContentResponse();
    Object.assign(mapped, {
      candidates: [
        {
          content: { parts, role: 'model' },
          finishReason:
            choice.finish_reason === 'length'
              ? FinishReason.MAX_TOKENS
              : FinishReason.STOP,
        },
      ],
      usageMetadata: {
        promptTokenCount: response.usage?.prompt_tokens,
        candidatesTokenCount: response.usage?.completion_tokens,
        totalTokenCount: response.usage?.total_tokens,
      },
    });
    return mapped;
  }
}
