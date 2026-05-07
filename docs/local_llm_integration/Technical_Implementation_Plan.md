# Technical Implementation Plan

## Overview
This document outlines the source code alterations necessary to inject an OpenAI-compatible adapter into the `Google-gemini-cli`.

## 1. Enum Definition Upgrades
**File:** `packages/core/src/core/contentGenerator.ts` (and relevant type definition files)
* Update `export enum AuthType` to include `USE_OPENAI_COMPATIBLE = 'USE_OPENAI_COMPATIBLE'`.
* Modify `isGemini31LaunchedForAuthType` and similar gatekeeper logic in `packages/core/src/config/config.ts` to allow basic execution for the new AuthType.

## 2. Create the Translation Layer (The OpenAI Generator)
**File:** `packages/core/src/core/openAiContentGenerator.ts` (New File)
* Implement the `ContentGenerator` interface native to the CLI core.
* Add dependency `openai` npm package to the `packages/core/package.json` file.
* Inside the new file, implement mapping algorithms defined in the **Data Domain Document**.

```typescript
import OpenAI from 'openai';
import type { ContentGenerator, GenerateContentParameters, GenerateContentResponse } from './types.js'; // Adjust relative path

export class OpenAiContentGenerator implements ContentGenerator {
  private openai: OpenAI;
  constructor(baseUrl: string, apiKey: string) {
    this.openai = new OpenAI({ baseURL: baseUrl, apiKey: apiKey || 'dummy-local-key' });
  }
  
  async generateContent(req: GenerateContentParameters, id: string, role: string): Promise<GenerateContentResponse> {
    const messages = mapGeminiToOpenAI(req);
    const response = await this.openai.chat.completions.create({
      model: req.model,
      messages: messages,
      temperature: req.config?.temperature,
      // Pass other fields like max_tokens.
    });
    return mapOpenAIToGemini(response);
  }
  
  // Implement generateContentStream identically using AsyncGenerator and client streams.
}
```

## 3. Wire Generator to the CLI Factory
**File:** `packages/core/src/core/contentGenerator.ts`
* Locate `export function createContentGenerator(...)`.
* Add custom branching logic. If `config.authType === AuthType.USE_OPENAI_COMPATIBLE`, instantiate and return `OpenAiContentGenerator` instead of `GoogleGenAI`.

```typescript
if (config.authType === AuthType.USE_OPENAI_COMPATIBLE) {
    // Load local IP/port mappings from user config
    const baseUrl = process.env['LOCAL_LLM_BASE_URL'] || 'http://localhost:8000/v1';
    const generator = new OpenAiContentGenerator(baseUrl, config.apiKey || 'dummy');
    
    if (gcConfig.recordResponses) {
      return new RecordingContentGenerator(generator, gcConfig.recordResponses);
    }
    return generator;
}
```

## 4. Update CLI Flag Handlers
**File:** `packages/cli/src/commands/...` and/or `packages/cli/src/config/...`
* Ensure the CLI argument parser captures `--base-url` and sets the `LOCAL_LLM_BASE_URL`.
* Ensure that if `--base-url` or a local target is supplied, it enforces `AuthType.USE_OPENAI_COMPATIBLE` configuration deep within the execution stack.
* Instruct the CLI users internally to utilize `--model gemma-4-26b`, bypassing internal Gemini alias checks that might error out due to unrecognized enumerations.
* **UI Hook:** Inject a terminal log interceptor that overlays `[Local Engine: <model>]` alongside the "Querying Gemini" outputs. Apply logic to conditionally hide/ignore normal quota progress bars **if and only if** `config.authType === AuthType.USE_OPENAI_COMPATIBLE`. Normal Gemini endpoints will retain their quota bars.

## 5. Tool Interception Strategy (Tool Reflection - Local Mode Only)
**Important Constraint:** This strategy is completely isolated from normal Google API execution. It operates **exclusively** inside the `OpenAiContentGenerator` class instance and will never intercept payloads destined for the official `GoogleGenAI` SDK.

**File:** `packages/core/src/core/openAiContentGenerator.ts`
Implement a `scrubAndMapTools()` class method that receives the Gemini generic tools array:

### 5.1 Tavily Web Search Mapping & Metering
1. If the tool is identical to `googleSearch`, map it strictly to an internal `tavily_search` Tool Definition matching OpenAI Tool Schema structure.
2. Maintain a file at `~/.gemini_cli_tavily_quota.json`. Write `{ "searches": 0, "month": "YYYY-MM" }`.
3. When the LLM calls `tavily_search`, verify the quota (`< 1000`).
4. Execute via standard Fetch mapped to the Tavily API `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` endpoint.
5. Return results to the loop and strictly increment the `.json` counter.

### 5.2 Local Active Code Execution sandbox
1. If the mapped array contains `codeExecution`, generate an `execute_python_code(code: string)` function declaration inside the `tools` payload bound for vLLM. 
2. Because Gemma-4 possesses internal token mechanisms for function requests, simply pass the system constraint identifying how it should output `execute_python_code`.
3. On invocation by the local Gemma-4 node, spawn a Node `child_process.exec('python3 -c "<decoded_string>"')`.
4. Capture `stdout/stderr` streams with a hardcoded timeout constraint (e.g. 10,000ms sandbox limit).
5. Append outputs verbatim and resume the Local Gemma generation.