# Local LLM Integration & Usage guide

This tutorial explains how to leverage the newly integrated OpenAI-compatible endpoint capabilities (such as vLLM or LiteLLM) seamlessly with the existing Google Gemini CLI.

## How it works
The `LOCAL_LLM_BASE_URL` environment variable instructs the CLI to bypass the native Google API `AuthType` logic. Instead of routing traffic to Google's cloud infrastructure, the internal system redirects API requests through the newly implemented OpenAI adapter schema.

---

## Global Workspace Usage
You can execute this CLI client from any directory or workspace on your machine.
If you are currently inside `/llm_models_python_code_src/Google-gemini-cli`, you can just call `node bundle/gemini.js`.

If you are executing from **a different workspace**, replace `bundle/gemini.js` with the absolute path to the bundle:
```bash
node /llm_models_python_code_src/Google-gemini-cli/bundle/gemini.js
```

---

## Execution Modes

### 1. Interactive CLI Mode (Standard TUI)
For an ongoing interactive console experience, start the CLI without the `-p` prompt flag.

```bash
export LOCAL_LLM_BASE_URL="http://192.168.1.168:4000/v1"
node /llm_models_python_code_src/Google-gemini-cli/bundle/gemini.js --model="gemma-4-26b"
```

### 2. Headless Mode (Non-interactive)
If you just want a single prompt execution sent directly to stdout (useful for scripts or rapid CI/CD deployment logic), provide the `-p` or `--prompt` flag:

```bash
export LOCAL_LLM_BASE_URL="http://192.168.1.168:4000/v1"
node /llm_models_python_code_src/Google-gemini-cli/bundle/gemini.js -p "What model is processing this request?" --model="gemma-4-26b"
```

---

## Tool Calling: Tavily Search & Local Code Execution

The custom OpenAI payload translation intercepts Google-exclusive tools and provides mapped functionality for them. When tools are provided, the CLI dynamically enables "Thinking + Tool Use" mode using `extra_body={"chat_template_kwargs": {"enable_thinking": True}}`.

### Enabling Thinking + Tool Use
Thinking paired with tools allows the LLM to deduce complex relationships before selecting arguments (greatly reducing hallucinations). Because it is natively injected by the adapter, you do not need to do anything manually. The LLM will output its `<|channel>thought` internal reasoning securely to vLLM, which parses and executes the matching tools cleanly.

### Web Search (`googleSearch` -> Tavily)
When the LLM intends to search the web, the internal adapter translates Google Search requests to Tavily Search queries (`tvly-dev` endpoint) ensuring zero dependencies on Google's API keys, while strictly metering usage against `~/.gemini_cli_tavily_quota.json`.

### Active Code Verification (`codeExecution`)
When the localized LLM requests Python execution, the adapter runs a localized Node.js `child_process.exec()` sandbox to evaluate generated logic dynamically and pipes standard output back into the conversation context.

### Example: Tool usage in Headless Mode
```bash
export LOCAL_LLM_BASE_URL="http://192.168.1.168:4000/v1"
node /llm_models_python_code_src/Google-gemini-cli/bundle/gemini.js -p "Use the web search tool to find the weather in Tokyo, then write and execute python code to convert it to Fahrenheit." --model="gemma-4-26b"
```

### Example: Tool usage in Interactive Mode
```bash
export LOCAL_LLM_BASE_URL="http://192.168.1.168:4000/v1"
node /llm_models_python_code_src/Google-gemini-cli/bundle/gemini.js "Search the web for the latest NVDK releases, then write a local python script to parse the dates." --model="gemma-4-26b"
```
