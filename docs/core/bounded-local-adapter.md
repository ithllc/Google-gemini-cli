# Bounded local-model adapter

This fork's OpenAI-compatible route now requires an explicitly pinned served
model, a verified context limit from `/v1/models`, and a compatible `/tokenize`
endpoint that applies the same chat template, system messages and tools as
inference. `LOCAL_LLM_BASE_URL` selects this route. Google-auth routes retain
their existing behavior.

Set `LOCAL_LLM_MODEL` to the exact served ID. Defaults are a32768-token
configured cap,2048 reserved output tokens,512 overhead tokens and45-second
request timeout; `LOCAL_LLM_CONTEXT_CAP`, `LOCAL_LLM_MAX_OUTPUT`,
`LOCAL_LLM_CONTEXT_SAFETY` and `LOCAL_LLM_TIMEOUT_MS` configure these values.
`LOCAL_LLM_DEADLINE_MS` adds an absolute deadline. Every initial/helper/retried
request is recounted. At60percent projected occupancy it returns
`LOCAL_CONTEXT_ROTATE`; above70percent it rejects. Unknown counts/capacity and
accounting/model discrepancies stop the request. The external controller owns
validated checkpointing and persistent attempt budgets.

`LOCAL_LLM_TOKENIZE_URL` selects the tokenizer endpoint when it is separate from
inference. An ordinary proxy advertising only model names is insufficient.
`LOCAL_LLM_PROTECTED_FILE` prepends an immutable instruction block; the
deployment must mount it read-only outside the writable workspace and enforce it
at its gateway. `LOCAL_LLM_AUDIT_FILE` optionally records owner-only
request/response digests, counts and decisions. It records no raw prompts, tool
output or credentials.

All tools return through the ordinary CLI scheduler with original IDs, including
mixed and repeated-name batches. The adapter never executes Python/shell/search
internally. Python uses the registered shell tool under the effective policy and
OS sandbox. Native provider execution, embeddings and multimodal input are
unqualified and explicitly rejected. Questions, delegation and skills cannot be
introduced through the local adapter. Configure an explicit/user/admin policy;
this fork currently disables workspace policy loading.

Registered `google_web_search` uses Tavily on the local route, after tool-policy
checks. A protected `LOCAL_SEARCH_GATEWAY` can own credentials/quota. Standalone
use requires `TAVILY_API_KEY` and `TAVILY_QUOTA_FILE`. Monthly reservations use
a cross-process lock and durable atomic writes; failures count against quota.
Requests have a10-second deadline, status and output checks, and source URLs.
The previously embedded credential was removed; it must be rotated externally.
No old-key fallback exists. Missing credentials defer search without a prompt.

These controls do not grant production authority. The consuming trading project
tracks isolation, scheduling, SQL state, independent testing and direct
publication in
[issue252](https://github.com/ithllc/DaySchwabOrderManagement/issues/252).
