const fs = require('fs');
const file = '/home/ithllc_ai/Google-gemini-cli/packages/core/src/core/openAiContentGenerator.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/return \{\n      candidates: \[\{/,
`require('fs').appendFileSync('/tmp/gemini_mapped_response.log', JSON.stringify({
      candidates: [{
        content: { parts: parts, role: 'model' },
        finishReason: resp.choices[0].finish_reason,
      }],
      usageMetadata: {
        promptTokenCount: resp.usage?.prompt_tokens,
        candidatesTokenCount: resp.usage?.completion_tokens,
        totalTokenCount: resp.usage?.total_tokens
      }
    }, null, 2) + '\\n');
    return {
      candidates: [{`);

fs.writeFileSync(file, code);
