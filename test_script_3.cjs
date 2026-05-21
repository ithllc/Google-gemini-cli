const fs = require('fs');
const file = '/home/ithllc_ai/Google-gemini-cli/packages/core/src/core/openAiContentGenerator.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/if \(tool\.functionDeclarations\) \{[\s\S]*?\}\n        \}/, 
`if (tool.functionDeclarations) {
          for (const func of tool.functionDeclarations) {
            if (func.name === 'google_web_search' || func.name === 'execute_python_code') continue;
            outTools.push({
              type: "function",
              function: {
                name: func.name,
                description: func.description || "",
                parameters: func.parametersJsonSchema || func.parameters || { type: "object", properties: {} }
              }
            });
          }
        }`);

fs.writeFileSync(file, code);
