const fs = require('fs');
const file = '/home/ithllc_ai/Google-gemini-cli/packages/core/src/core/openAiContentGenerator.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/finishReason: resp\.choices\[0\]\.finish_reason/,
`finishReason: resp.choices[0].finish_reason === 'tool_calls' ? 'STOP' : resp.choices[0].finish_reason`);

fs.writeFileSync(file, code);
