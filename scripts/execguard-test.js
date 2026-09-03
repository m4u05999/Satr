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

const shellCases = [
  ['cd /d D:\\work', 'powershell.exe', ['cd /d']],
  ['npm run lint && npm run test', 'powershell.exe', ['&&']],
  ['npm run lint || npm run fallback', 'powershell.exe', ['||']],
  // pwsh 7+ يدعم && و|| — حجبهما هناك إيجابية كاذبة (مراجعة القائد)
  ['npm run lint || npm run fallback', 'pwsh.exe', []],
  ['npm run lint && npm run test', 'pwsh.exe', []],
  // tee اسم مستعار صالح لـTee-Object في 5.1، و~/ مسار المنزل صالح — لا يُحجبان (قِيسا)
  ['npm run test | tee dist\\test.log', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', []],
  ['node script.js 2>/dev/null', 'powershell.exe', ['2>/dev/null']],
  ['node script.js >/dev/null', 'powershell.exe', ['>/dev/null']],
  ['export API_URL=https://example.test', 'pwsh.exe', ['export API_URL=']],
  ['Get-Content ~/notes.txt', 'powershell.exe', []],
  ['cd /d D:\\work && npm run test | tee dist\\test.log', 'powershell.exe', ['cd /d', '&&']],
  ['npm.cmd run x 2>&1 | Tee-Object -FilePath dist\\log.log', 'powershell.exe', []],
  ['node -e "a && b"', 'powershell.exe', []],
  ['git commit -m "x && y"', 'powershell.exe', []],
  ['node -e "a && b" && npm run done', 'powershell.exe', ['&&']],
  ["Write-Output 'x || y'", 'powershell.exe', []],
  ['powershell.exe -Command "npm run x && npm run y"', 'powershell.exe', []],
  ['Write-Output "2>/dev/null; export X=1; ~/x; | tee x"', 'powershell.exe', []],
  ['Write-Output ok # npm run x && npm run y', 'powershell.exe', []],
  ['Write-Output cd /d; Write-Output export X=1', 'powershell.exe', []],
  ["$text = @'\nbody && export X=1 | tee out\n'@\nWrite-Output $text", 'powershell.exe', []],
  ['cd /d D:\\work && export X=1', 'cmd.exe', []],
  ['export X=1 2>/dev/null', '/bin/bash', []],
  ['Set-Location D:\\work; npm.cmd run x 2>&1 | Tee-Object -FilePath dist\\log.log', 'pwsh.exe', []],
];
for (const [command, shell, expected] of shellCases) {
  const actual = guard.shellSyntaxProblems(command, shell);
  assert.deepStrictEqual(actual.map((problem) => problem.token), expected,
    'نتيجة صياغة غير متوقعة: ' + shell + ' :: ' + command);
  for (const problem of actual) {
    assert.deepStrictEqual(Object.keys(problem).sort(), ['hint', 'token'], 'تسرّب حقل داخلي من عقد المشكلة');
    assert(problem.hint && /PowerShell/.test(problem.hint), 'تلميح ناقص: ' + problem.token);
  }
}

console.log('execguard: نجح — أنماط الخوادم و24 حالة لصياغة الصدفة بلا إيجابيات مقتبسة، وtee/~/ وpwsh لا تُحجب.');
