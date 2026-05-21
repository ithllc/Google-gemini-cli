const fs = require('fs');
const file = '/home/ithllc_ai/Google-gemini-cli/packages/core/src/core/openAiContentGenerator.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
/const out = execSync\(`python3 -c \$\{JSON.stringify\(args.code\)\}`, \{ encoding: 'utf8', stdio: 'pipe' \}\);/,
`        const tmpFile = require('os').tmpdir() + '/gemini_cli_exec_' + Date.now() + '.py';
        fs.writeFileSync(tmpFile, args.code);
        const out = execSync(\`python3 \${tmpFile}\`, { encoding: 'utf8', stdio: 'pipe' });
        fs.unlinkSync(tmpFile);`
);

fs.writeFileSync(file, code);
