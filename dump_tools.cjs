const fs = require('fs');
const file = '/home/ithllc_ai/Google-gemini-cli/packages/core/src/core/openAiContentGenerator.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/if \(process\.env\.GEMINI_DISABLE_TOOLS === "true"\)/,
`require('fs').appendFileSync('/tmp/req_tools.log', JSON.stringify({tools: req.tools, configTools: req.config?.tools}, null, 2) + '\\n');
    if (process.env.GEMINI_DISABLE_TOOLS === "true")`);

fs.writeFileSync(file, code);
