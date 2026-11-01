/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import OpenAI from 'openai';
import type { 
  GenerateContentParameters, 
  GenerateContentResponse, 
  CountTokensParameters, 
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse
} from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import type { UserTierId } from '../code_assist/types.js';
import type { LlmRole } from '../telemetry/llmRole.js';

export class OpenAiContentGenerator implements ContentGenerator {
  private openai: OpenAI;
  private baseUrl: string;
  private modelMap: Record<string, string> = {};
  private modelListFetched = false;
  userTier?: UserTierId;
  userTierName?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    const opts: any = {
      baseURL: baseUrl,
      timeout: 1200000, // Explicitly set generous timeout to accommodate recursive tool execution loops
      maxRetries: 3,
    };
    // Only supply an apiKey to the OpenAI client when one is explicitly provided.
    // Avoid sending a bogus/default key which some backends treat as an invalid API key.
    if (apiKey) {
      opts.apiKey = apiKey;
    }
    this.openai = new OpenAI(opts);
  }

  private async fetchModelList(): Promise<void> {
    if (this.modelListFetched) return;
    this.modelListFetched = true;
    try {
      const url = (this.baseUrl || '').replace(/\/$/, '') + '/models';
      const res = await fetch(url, { method: 'GET' } as any);
      if (!res.ok) return;
      const json = await res.json();
      const models = Array.isArray(json) ? json : json?.models ?? [];
      for (const m of models) {
        const id = m.id || m.root || '';
        if (!id) continue;
        this.modelMap[id] = id;
        const parts = id.split('/');
        const short = parts[parts.length - 1];
        if (short) this.modelMap[short] = id;
        if (m.root) {
          const rootBase = String(m.root).split('/').pop();
          if (rootBase) this.modelMap[rootBase] = id;
          this.modelMap[m.root] = id;
        }
      }
    } catch (e) {
      // ignore errors, leave modelMap empty
    }
  }

  private async resolveModelName(name?: string): Promise<string | undefined> {
    if (!name) return undefined;
    await this.fetchModelList();
    return this.modelMap[name] ?? name;
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const tools = this.scrubAndMapTools(request);
    const resolvedModel = await this.resolveModelName(request.model || 'gemma-4-26b');
    const payload: any = {
      model: resolvedModel,
      messages: this.mapGeminiToOpenAI(request),
      temperature: request.config?.temperature,
      max_tokens: request.config?.maxOutputTokens, // Let the backend `--max-model-len` constraint handle bounds
    };

    if (tools) {
      payload.tools = tools;
      payload.extra_body = {
        chat_template_kwargs: {
          enable_thinking: true
        }
      };
    }

    let response; try { response = await this.openai.chat.completions.create(payload, { timeout: 1200000 }); } catch (e: any) { require("fs").appendFileSync("/tmp/req_tools.log", "\n\nERROR: " + e.message); throw e; }
    
    if (response.choices[0].message.tool_calls) {
      return this.executeToolCall(request, response.choices[0].message, userPromptId, role);
    }
    
    require('fs').appendFileSync('/tmp/debug_resp.json', '\n\n' + JSON.stringify(response, null, 2)); return this.mapOpenAIToGemini(response);
  }

      async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const self = this;
    async function* generator() {
      const response = await self.generateContent(request, userPromptId, role);
      yield response;
    }
    return generator();
  }

  async countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    return { totalTokens: 0 };
  }

  async embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    return { embeddings: [] };
  }

  private scrubAndMapTools(req: any): any[] | undefined {
    require('fs').appendFileSync('/tmp/req_tools.log', JSON.stringify(req, null, 2) + '\n');
    if (process.env['GEMINI_DISABLE_TOOLS'] === "true") {
      return undefined;
    }
    const outTools: any[] = [];
    const seenToolNames = new Set<string>();
    const inTools = req.tools || (req.config && req.config.tools) || [];

    const addTool = (name: string, description: string, parameters: any) => {
      if (!name || seenToolNames.has(name)) {
        return;
      }
      seenToolNames.add(name);
      outTools.push({
        type: "function",
        function: {
          name,
          description: description || "",
          parameters: parameters || { type: "object", properties: {} }
        }
      });
    };

    if (Array.isArray(inTools)) {
      for (const tool of inTools) {
        if (tool.functionDeclarations) {
          for (const func of tool.functionDeclarations) {
            addTool(
              func.name,
              func.description || "",
              func.parametersJsonSchema || func.parameters || { type: "object", properties: {} },
            );
          }
        }

        if (tool.googleSearch !== undefined) {
          addTool(
            "google_web_search",
            "Search the web for real-time information. Returns a JSON string of search results.",
            {
              type: "object",
              properties: {
                query: { type: "string", description: "The search query" }
              },
              required: ["query"]
            },
          );
        }

        if (tool.codeExecution !== undefined) {
          addTool(
            "execute_python_code",
            "Execute python code generated by the model. Returns execution output.",
            {
              type: "object",
              properties: {
                code: { type: "string", description: "The python code to execute" }
              },
              required: ["code"]
            },
          );
        }
      }
    }

    return outTools.length > 0 ? outTools : undefined;
  }
  
  private async interceptFunctionCall(req: any, call: any): Promise<any> {
    const fs = require('node:fs');
    const { execSync } = require('node:child_process');
    const os = require('node:os');
    
    if (call.name === 'tavily_search' || call.name === 'googleSearch' || call.name === 'google_web_search') {
      const args = JSON.parse(call.arguments);
      const query = args.query;
      
      const quotaFile = os.homedir() + '/.gemini_cli_tavily_quota.json';
      let quota = { searches: 0 };
      if (fs.existsSync(quotaFile)) {
        try { quota = JSON.parse(fs.readFileSync(quotaFile, 'utf8')); } catch (e) {}
      }
      
      if (quota.searches >= 1000) {
        return JSON.stringify({ error: "Tavily search quota exceeded for this month." });
      }
      quota.searches += 1;
      fs.writeFileSync(quotaFile, JSON.stringify(quota));
      
      try {
        const resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: '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',
            query,
            search_depth: "basic",
            include_answer: false,
            max_results: 3
          })
        });
        const data = await resp.json();
        return JSON.stringify(data);
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    } 
    else if (call.name === 'execute_python_code' || call.name === 'codeExecution') {
      const args = JSON.parse(call.arguments);
      try {
                const tmpFile = require('os').tmpdir() + '/gemini_cli_exec_' + Date.now() + '.py';
        fs.writeFileSync(tmpFile, args.code);
        const out = execSync(`python3 ${tmpFile}`, { encoding: 'utf8', stdio: 'pipe' });
        fs.unlinkSync(tmpFile);
        return JSON.stringify({ output: out });
      } catch (err: any) {
        return JSON.stringify({ error: err.message, stderr: err.stderr });
      }
    }
    
    return JSON.stringify({ error: "Unsupported tool call" });
  }

  private async executeToolCall(req: GenerateContentParameters, responseMessage: any, userPromptId: string, role: string, previousMessages?: any[], depth: number = 0): Promise<GenerateContentResponse> {
    if (depth >= 15) {
      return this.mapOpenAIToGemini({
        choices: [{
          message: { content: "I've reached the maximum number of tool execution steps." },
          finish_reason: "length"
        }],
        usage: {}
      });
    }

    require('fs').appendFileSync('/tmp/tool_calls.log', JSON.stringify(responseMessage, null, 2) + '\n');
    
    // Check if tool is internal to proxy
    let hasInternalTools = false;
    let hasExternalTools = false;
    
    if (responseMessage.tool_calls) {
      for (const call of responseMessage.tool_calls) {
        if (['tavily_search', 'execute_python_code', 'googleSearch', 'google_web_search', 'codeExecution'].includes(call.function.name)) {
          hasInternalTools = true;
        } else {
          hasExternalTools = true;
        }
      }
    }
    
    // If it only has external tools, just return them to the CLI!
    if (hasExternalTools && !hasInternalTools) {
       return this.mapOpenAIToGemini({ choices: [{ message: responseMessage, finish_reason: "tool_calls" }] });
    }

    const messages = previousMessages || this.mapGeminiToOpenAI(req);
    messages.push(responseMessage);

    if (responseMessage.tool_calls) {
      for (const call of responseMessage.tool_calls) {
        const callId = call.id;
        const callResult = await this.interceptFunctionCall(req, call.function);
        messages.push({
          role: "tool",
          tool_call_id: callId,
          name: call.function.name,
          content: callResult
        });
      }
    }
    
    const tools = this.scrubAndMapTools(req);
    const resolvedModel = await this.resolveModelName(req.model || 'gemma-4-26b');
    const payload: any = {
      model: resolvedModel,
      messages
    };

    if (tools) {
      payload.tools = tools;
      payload.extra_body = {
        chat_template_kwargs: {
          enable_thinking: true
        }
      };
    }
    
    let response; try { response = await this.openai.chat.completions.create(payload, { timeout: 1200000 }); } catch (e: any) { require("fs").appendFileSync("/tmp/req_tools.log", "\n\nERROR INNER: " + e.message); throw e; }
    
    if (response.choices[0].message.tool_calls) {
      return await this.executeToolCall(req, response.choices[0].message, userPromptId, role, messages, depth + 1);
    }
    
    return this.mapOpenAIToGemini(response);
  }

    private mapGeminiToOpenAI(req: GenerateContentParameters): any[] {
    const messages: any[] = [];
    const anyReq = req as any;
    if (anyReq.systemInstruction?.parts) {
      messages.push({ role: 'system', content: anyReq.systemInstruction.parts.map((p: any) => p.text).join('\n') });
    }
    const contentsArray = Array.isArray(req.contents) ? req.contents : (req.contents ? [req.contents] : []);
    for (const c of contentsArray) {
      const anyC = c as any;
      const parts = Array.isArray(anyC.parts) ? anyC.parts : [];
      
      const fnResponses = parts.filter((p: any) => !!p.functionResponse);
      const fnCalls = parts.filter((p: any) => !!p.functionCall);
      const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text).join('\n');
      
      if (fnResponses.length > 0) {
        for (const p of fnResponses) {
           messages.push({
             role: 'tool',
             tool_call_id: p.functionResponse.id || (p.functionResponse.name + "_id"),
             name: p.functionResponse.name,
             content: typeof p.functionResponse.response === 'string' ? p.functionResponse.response : JSON.stringify(p.functionResponse.response)
           });
        }
      } 
      
      if (textParts || fnCalls.length > 0) {
        let msg: any = {
          role: anyC.role === 'model' ? 'assistant' : 'user',
        };
        if (textParts) msg.content = textParts;
        
        if (fnCalls.length > 0) {
          msg.tool_calls = fnCalls.map((p: any) => ({
            id: p.functionCall.id || (p.functionCall.name + "_id"),
            type: "function",
            function: {
               name: p.functionCall.name,
               arguments: typeof p.functionCall.args === 'string' ? p.functionCall.args : JSON.stringify(p.functionCall.args)
            }
          }));
        }
        messages.push(msg);
      }
    }
    return messages;
  }

  private mapOpenAIToGemini(resp: any): GenerateContentResponse {
    const message = resp.choices[0].message;
    const parts: any[] = [];
    if (message.content) {
      parts.push({ text: message.content });
    }
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        parts.push({
          functionCall: {
            name: call.function.name,
            args: call.function.arguments ? JSON.parse(call.function.arguments) : {}
          }
        });
      }
    }
    // ensure at least empty text if no parts to avoid validation errors
    if (parts.length === 0) {
      parts.push({ text: "" });
    }
    
    
    const mappedResp = {
      candidates: [{
        content: { parts: parts, role: 'model' },
        finishReason: parts.some(p => p.functionCall) ? undefined : (resp.choices[0].finish_reason === "tool_calls" ? "STOP" : resp.choices[0].finish_reason)
      }],
      functionCalls: parts.filter(p => p.functionCall).map(p => {
        const fc = p.functionCall;
        return {
           id: "synth_mapped_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
           name: fc.name,
           args: fc.args
        };
      }),
      usageMetadata: {
        promptTokenCount: resp.usage?.prompt_tokens,
        candidatesTokenCount: resp.usage?.completion_tokens,
        totalTokenCount: resp.usage?.total_tokens
      }
    };
    require('fs').appendFileSync('/tmp/gemini_mapped_response.log', JSON.stringify(mappedResp, null, 2) + '\n');
    return mappedResp as GenerateContentResponse;
  }
}
