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
  public userTier?: UserTierId;
  public userTierName?: string;

  constructor(baseUrl: string, apiKey: string) {
    this.openai = new OpenAI({ 
      baseURL: baseUrl, 
      apiKey: apiKey || 'dummy-local-key' 
    });
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const response = await this.openai.chat.completions.create({
      model: request.model || 'gemma-4-26b',
      messages: this.mapGeminiToOpenAI(request),
      temperature: request.config?.temperature,
      max_tokens: request.config?.maxOutputTokens,
    });
    return this.mapOpenAIToGemini(response);
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

  private mapGeminiToOpenAI(req: GenerateContentParameters): any[] {
    const messages: any[] = [];
    const anyReq = req as any;
    if (anyReq.systemInstruction?.parts) {
      messages.push({ role: 'system', content: anyReq.systemInstruction.parts.map((p: any) => p.text).join('\n') });
    }
    const contentsArray = Array.isArray(req.contents) ? req.contents : (req.contents ? [req.contents] : []);
    for (const c of contentsArray) {
      const anyC = c as any;
      messages.push({
        role: anyC.role === 'model' ? 'assistant' : anyC.role,
        content: Array.isArray(anyC.parts) ? anyC.parts.map((p: any) => p.text).join('\n') : ''
      });
    }
    return messages;
  }

  private mapOpenAIToGemini(resp: any): GenerateContentResponse {
    return {
      candidates: [{
        content: { parts: [{ text: resp.choices[0].message.content }], role: 'model' },
        finishReason: resp.choices[0].finish_reason,
      }],
      usageMetadata: {
        promptTokenCount: resp.usage?.prompt_tokens,
        candidatesTokenCount: resp.usage?.completion_tokens,
        totalTokenCount: resp.usage?.total_tokens
      }
    } as GenerateContentResponse;
  }
}
