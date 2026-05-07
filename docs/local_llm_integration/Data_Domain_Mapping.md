# Data Domain Mapping Document

## Purpose
This document maps internal Google Generative AI configurations (`GenerateContentParameters`, `Content`, `Part`) to strict OpenAI equivalents. This is essential for transparently converting internal requests to vLLM or LiteLLM.

## Schema Flow
`Incoming CLI Payload (Gemini)` -> `Adapter (openAiContentGenerator.ts)` -> `OpenAI Payload` -> `Local Hardware (vLLM/LiteLLM)`

## 1. Top-Level Message Mapping
| Google GenAI Property | OpenAI Target Property | Transformation Rule |
|---|---|---|
| `systemInstruction.parts` | `messages[0]` (system) | Collapse `parts` array to a string. Prepend array: `{ role: "system", content: "..." }` |
| `contents[]` | `messages[]` | Iterate incoming array and map roles and parts appropriately. |
| `config.temperature` | `temperature` | Direct mapping (number to number). |
| `config.topP` | `top_p` | Direct mapping (number to number). |
| `config.maxOutputTokens` | `max_tokens` | Direct mapping (number to number). |

## 2. Role Translation
| Google GenAI Role | OpenAI Role Target |
|---|---|
| `"user"` | `"user"` |
| `"model"` | `"assistant"` |
| `"function"` | `"tool"` |

## 3. Parts Extraction rules (`Content` -> `Message`)

### Text Parts
**Google:** `{ text: "Hello" }`
**OpenAI:** `"Hello"` (If standard prompt) OR `{ type: "text", text: "Hello" }` (If multimodal array required).

### Image / Multimodal Parts (For vLLM Port 8001 / Port 8002)
**Google:** 
```json
{ inlineData: { mimeType: "image/jpeg", data: "<base64>" } }
```
**OpenAI:**
```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/jpeg;base64,<base64>"
  }
}
```

### Resulting Object Map Example
```json
// Internal CLI Request:
{
  "systemInstruction": { "parts": [{ "text": "Answer briefly." }] },
  "contents": [
    { 
      "role": "user", 
      "parts": [{ "text": "What model name is processing this request?" }]
    }
  ]
}

// Translated Payload (Sent to LiteLLM/vLLM):
{
  "messages": [
    { "role": "system", "content": "Answer briefly." },
    { "role": "user", "content": "What model name is processing this request?" }
  ]
}
```

## 4. Returning Schema
Once the vLLM / LiteLLM server resolves the prompt, we receive standard OpenAI JSON structure. It must be mapped back for the CLI downstream services.

| OpenAI Response Property | Google Client Mapped Property |
|---|---|
| `choices[0].message.content` | `candidates[0].content.parts[0].text` |
| `choices[0].finish_reason` | `candidates[0].finishReason` |
| `usage.total_tokens` | `usageMetadata.totalTokenCount` |

Once mapped recursively, the CLI interfaces will output data identically as if it spoke natively to a Google cloud endpoint, resolving our compatibility matrix explicitly over our targeted instances (vLLM local and liteLLM proxied logic).