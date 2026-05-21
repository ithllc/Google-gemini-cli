const fs = require('fs');
const file = '/home/ithllc_ai/Google-gemini-cli/packages/core/src/core/openAiContentGenerator.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/private mapGeminiToOpenAI\(req: GenerateContentParameters\): any\[\] \{[\s\S]*?return messages;\n  \}/, 
`private mapGeminiToOpenAI(req: GenerateContentParameters): any[] {
    const messages: any[] = [];
    const anyReq = req as any;
    if (anyReq.systemInstruction?.parts) {
      messages.push({ role: 'system', content: anyReq.systemInstruction.parts.map((p: any) => p.text).join('\\n') });
    }
    const contentsArray = Array.isArray(req.contents) ? req.contents : (req.contents ? [req.contents] : []);
    for (const c of contentsArray) {
      const anyC = c as any;
      if (anyC.role === 'function') {
        const parts = Array.isArray(anyC.parts) ? anyC.parts : [];
        for (const p of parts) {
          if (p.functionResponse) {
             messages.push({
               role: 'tool',
               tool_call_id: p.functionResponse.name + "_id",
               name: p.functionResponse.name,
               content: JSON.stringify(p.functionResponse.response)
             });
          }
        }
      } else {
        const parts = Array.isArray(anyC.parts) ? anyC.parts : [];
        const textParts = parts.filter(p => p.text).map(p => p.text).join('\\n');
        
        let msg: any = {
          role: anyC.role === 'model' ? 'assistant' : anyC.role,
        };
        if (textParts) msg.content = textParts;
        
        let tool_calls = [];
        for (const p of parts) {
          if (p.functionCall) {
            tool_calls.push({
              id: p.functionCall.name + "_id",
              type: "function",
              function: {
                 name: p.functionCall.name,
                 arguments: JSON.stringify(p.functionCall.args)
              }
            });
          }
        }
        if (tool_calls.length > 0) {
           msg.tool_calls = tool_calls;
        }
        
        messages.push(msg);
      }
    }
    return messages;
  }`);

code = code.replace(/private mapOpenAIToGemini\(resp: any\): GenerateContentResponse \{[\s\S]*?\} as GenerateContentResponse;\n  \}/, 
`private mapOpenAIToGemini(resp: any): GenerateContentResponse {
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
    
    return {
      candidates: [{
        content: { parts: parts, role: 'model' },
        finishReason: resp.choices[0].finish_reason,
      }],
      usageMetadata: {
        promptTokenCount: resp.usage?.prompt_tokens,
        candidatesTokenCount: resp.usage?.completion_tokens,
        totalTokenCount: resp.usage?.total_tokens
      }
    } as GenerateContentResponse;
  }`);

code = code.replace(/private async executeToolCall[\s\S]*?return this\.mapOpenAIToGemini\(response\);\n  \}/, 
`private async executeToolCall(req: GenerateContentParameters, responseMessage: any, userPromptId: string, role: string, previousMessages?: any[], depth: number = 0): Promise<GenerateContentResponse> {
    if (depth >= 3) {
      return this.mapOpenAIToGemini({
        choices: [{
          message: { content: "I've reached the maximum number of tool execution steps." },
          finish_reason: "length"
        }],
        usage: {}
      });
    }

    require('fs').appendFileSync('/tmp/tool_calls.log', JSON.stringify(responseMessage, null, 2) + '\\n');
    
    // Check if tool is internal to proxy
    let hasInternalTools = false;
    let hasExternalTools = false;
    
    if (responseMessage.tool_calls) {
      for (const call of responseMessage.tool_calls) {
        if (call.function.name === 'tavily_search' || call.function.name === 'execute_python_code') {
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
    const payload: any = {
      model: req.model || 'gemma-4-26b',
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
    
    const response = await this.openai.chat.completions.create(payload);
    
    if (response.choices[0].message.tool_calls) {
      return await this.executeToolCall(req, response.choices[0].message, userPromptId, role, messages, depth + 1);
    }
    
    return this.mapOpenAIToGemini(response);
  }`);

fs.writeFileSync(file, code);
