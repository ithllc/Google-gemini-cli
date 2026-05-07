# Product Requirements Document (PRD)

## 1. Objective
To enhance the forked `Google-gemini-cli` to natively support local, self-hosted, and transparently proxied large language models via the OpenAI Chat Completions API specification. Specifically, this integration will target interoperability with **vLLM** and **liteLLM** engines operating on a local or local-network distributed setup (e.g., an ASUS GX10 machine).

## 2. Background and Context
The default `Google-gemini-cli` relies strictly on the Google GenAI SDK and requires cloud connectivity to Google endpoints (Gemini API or Vertex AI). With the increasing capability of local models like `gemma-4-26b` and `gemma-4-e4b-multimodal`, developers require the CLI tooling to transparently execute prompts against their local hardware using OpenAI schema-compliant servers (like vLLM or LiteLLM).

## 3. Scope
**In Scope:**
* Introduction of an `--auth-type` configuration override to utilize local-compatible endpoints.
* Allowing overrides for Base URLs.
* Support for single-turn and multi-turn generation.
* Support for multimodal queries (text and image) querying models hosted on `vLLM`.
* Automatic routing of the internal Google GenAI SDK's `GenerateContentParameters` object into an OpenAI compliant `messages` array payload.
* Interfacing successfully with user-defined target hardware over ports `8001` (text/image vLLM), `8002` (audio/video vLLM), and `4000` (LiteLLM proxy).
* **Tool Reflection Mechanism (Local Mode Only):** Gracefully adapting or stripping proprietary Google tools (e.g., `googleSearch` replaced by `TavilyMCP`, `codeExecution` replaced by Local Python Subprocess). This applies exclusively when `USE_OPENAI_COMPATIBLE` is active.
* **Quota & UI Interception (Local Mode Only):** Masking existing Google quota meters and appending confirmation text acknowledging local engine parsing in the UI. Native Google API connections will retain their original meters.

**Out of Scope:**
* Porting or modifying existing CLI UI prompts beyond the single Engine Confirmation overlay.
* Hosting or launching the vLLM/liteLLM infrastructure itself (the CLI assumes the endpoints are already active).

## 4. Environment & Test Specifications
Testing will be strictly validated against the following setups:

1. **vLLM Instance 1 (Text & Images)**
   * **Endpoint:** `http://localhost:8001/v1/chat/completions`
   * **Target Model:** `gemma-4-26b`
2. **vLLM Instance 2 (Multimodal: Audio/Video)**
   * **Endpoint:** `http://localhost:8002/v1/chat/completions`
   * **Target Model:** `gemma-4-e4b-multimodal`
3. **LiteLLM Gateway**
   * **Endpoint:** `http://192.168.1.168:4000/v1/chat/completions`
   * **Target Model:** `gemma-4-26b` (and others resolved via `http://192.168.1.168:4000/v1/models`)

## 5. Functional Requirements
| Req ID | Requirement | Priority |
|---|---|---|
| F-01 | **New AuthType:** Add `USE_OPENAI_COMPATIBLE` to the CLI `AuthType` enum. | P0 |
| F-02 | **Endpoint Flexibility:** Users must be able to specify custom Base URLs via config or CLI args `--base-url`. | P0 |
| F-03 | **Model Declaration:** Users must be able to specify the exact local model name (e.g., `--model gemma-4-26b`) replacing `gemini-1.5-pro`. | P0 |
| F-04 | **Schema Translator:** An internal adapter must intercept Gemini schema requests and mutate them into OpenAI messages format transparently. | P0 |
| F-05 | **Multi-modal adapter:** Conversion layer must handle image/audio parts and map them to OpenAI's local multi-modal schema patterns. | P1 |
| F-06 | **Quota Erasure & UI Mask:** (Local Only) UI quota meters must report "unlimited" or be hidden. Insert `[Local Engine: <model>]` alongside "Querying Gemini" UI headers. | P0 |
| F-07 | **Tavily MCP Replacement:** (Local Only) Intercept the `googleSearch` tool request, convert to `tavily-search`. Implement a local JSON quota tracker (1000 limit/month). | P1 |
| F-08 | **Gemma 4 Code Execution Regex:** (Local Only) Intercept the Google `codeExecution` tool request. Serve internal Sandbox Python execution Subprocess for local Gemma generation. | P0 |

## 6. Success Metrics
* Successful terminal execution using `gemini-cli --base-url http://localhost:8001/v1 --model gemma-4-26b "Hello"`.
* Validation of streaming tokens natively printing in the console.
* 0 regression on existing Vertex/Gemini connections when `AuthType` is not set to `USE_OPENAI_COMPATIBLE`.