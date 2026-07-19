'use strict';

const assert = require('assert');
const guard = require('../electron/execguard');

const positives = [
  'npm run dev', 'pnpm run start -- --port 3000', 'yarn run serve', 'bun run watch',
  'vite --host', 'next dev', 'nuxt dev', 'astro dev', 'ng serve', 'webpack serve',
  'python -m http.server 8000', 'python3 -m http.server', 'php -S localhost:8080',
  'flask run', 'rails s', 'rails server', 'node src/server.js', 'node serve.mjs',
  'npx serve .', 'npx http-server', 'npx live-server', 'npx json-server db.json',
];
for (const command of positives) assert(guard.isServerCommand(command), 'لم يُلتقط خادم: ' + command);

const negatives = [
  'npm run build', 'npm run test', 'pnpm run lint', 'node scripts/build.js',
  'python script.py', 'git status', 'rg server electron', 'echo npm run dev',
];
for (const command of negatives) assert(!guard.isServerCommand(command), 'إيجابي كاذب: ' + command);

assert(guard.isBackgroundBash('Bash', { run_in_background: true }));
assert(guard.isBackgroundBash('mcp__satr-terminal__run_in_terminal', { run_in_background: true }));
assert(!guard.isBackgroundBash('Bash', { run_in_background: false }));
assert(!guard.isBackgroundBash('run_in_background', { run_in_background: true }));
assert(/run_in_background/.test(guard.buildRedirectMessage()));
assert(/open_preview/.test(guard.buildRedirectMessage()));

console.log('execguard: نجح — أنماط الخوادم والتحويل بلا إيجابيات build/test.');
