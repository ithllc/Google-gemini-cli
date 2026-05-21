const fs = require('fs');
const file = '/home/ithllc_ai/Google-gemini-cli/packages/core/src/core/openAiContentGenerator.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/if \(depth >= 3\) \{/, `if (depth >= 5) {`);

fs.writeFileSync(file, code);
