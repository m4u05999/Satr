#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const repomap = require('../electron/repomap');
const tools = require('../electron/tools');

async function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-repomap-test-'));
  const project = path.join(temp, 'project');
  await fsp.mkdir(project, { recursive: true });
  try {
    await write(project, 'src/auth-service.js', [
      'export async function authenticate(user) { return !!user; }',
      'class SessionManager {}',
      'const TOKEN_TTL = 3600;',
      'const ordinary = "BODY_MARKER_MUST_NOT_LEAK";',
    ].join('\n'));
    await write(project, 'src/math.py', [
      'PI_APPROX = 3.14',
      'class Calculator:',
      '    pass',
      'def add(left, right):',
      '    return left + right',
    ].join('\n'));
    await write(project, 'src/server.go', [
      'package main',
      'type Server struct {}',
      'func NewServer() *Server { return &Server{} }',
    ].join('\n'));
    await write(project, 'src/prominence.js', [
      ...Array.from({ length: 20 }, (_, index) => '  const localValue' + index + ' = ' + index + ';'),
      'export class LateService {}',
    ].join('\n'));
    await write(project, 'package.json', '{"name":"fixture"}\n');
    await write(project, 'README.md', '# Fixture\n');
    await write(project, 'src/large.js', 'const SHOULD_BE_SKIPPED = 1;\n' + 'x'.repeat(repomap.MAX_FILE_BYTES + 20));
    await write(project, 'node_modules/hidden.js', 'export function mustNotAppear() {}\n');
    for (let index = 0; index < 30; index++) {
      await write(project, 'src/generated/file-' + String(index).padStart(2, '0') + '.js',
        'export const GENERATED_' + index + ' = ' + index + ';\n');
    }

    const result = await repomap.build(project, 'authenticate session', { maxOutputChars: 4000 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.estimate, true);
    assert(result.text.startsWith('<satr_repo_map estimate="true"'));
    assert(result.text.includes('Approximate regex-based repository map'));
    assert(!result.text.includes('BODY_MARKER_MUST_NOT_LEAK'));
    assert(!result.files.some((entry) => entry.rel.includes('node_modules')));
    assert.strictEqual(result.files[0].rel, 'src/auth-service.js');
    const auth = result.files.find((entry) => entry.rel === 'src/auth-service.js');
    assert(auth.symbols.some((symbol) => symbol.name === 'authenticate' && symbol.line === 1));
    assert(auth.symbols.some((symbol) => symbol.name === 'SessionManager' && symbol.kind === 'class'));
    assert(auth.symbols.some((symbol) => symbol.name === 'TOKEN_TTL'));
    const python = result.files.find((entry) => entry.rel === 'src/math.py');
    assert(python.symbols.some((symbol) => symbol.name === 'Calculator'));
    assert(python.symbols.some((symbol) => symbol.name === 'add'));
    const go = result.files.find((entry) => entry.rel === 'src/server.go');
    assert(go.symbols.some((symbol) => symbol.name === 'NewServer'));
    const prominence = result.files.find((entry) => entry.rel === 'src/prominence.js');
    assert(prominence.symbols.some((symbol) => symbol.name === 'LateService'), 'يجب أن تتقدم export/class على الثوابت المحلية');
    assert.strictEqual(result.skipped_large, 1);
    assert(result.files.every((entry) => entry.symbols.length <= repomap.MAX_SYMBOLS_PER_FILE));
    assert(result.files.reduce((sum, entry) => sum + entry.symbols.length, 0) <= repomap.MAX_TOTAL_SYMBOLS);

    const bounded = await repomap.build(project, '', { maxFiles: 5, maxFilesOut: 3, maxOutputChars: 800 });
    assert(bounded.scanned <= 5);
    assert(bounded.files.length <= 3);
    assert.strictEqual(bounded.partial, true);
    assert(bounded.text.length <= 800);

    let tick = 0;
    const timed = await repomap.build(project, '', { timeBudgetMs: 1, now: () => { tick += 10; return tick; } });
    assert.strictEqual(timed.scanned, 0);
    assert.strictEqual(timed.partial, true);

    const definitions = tools.defs().map((definition) => definition.function.name);
    assert(definitions.includes('repo_map'));
    assert.strictEqual(tools.permissionTier('repo_map'), null);
    const toolResult = await tools.run('repo_map', project, { query: 'calculator' });
    assert.strictEqual(toolResult.ok, true);
    assert(toolResult.content.includes('estimate="true"'));
    assert(toolResult.content.includes('src/math.py'));

    console.log('✓ repo map extracts prioritized multi-language symbols');
    console.log('✓ repo map reuses file boundaries and skips oversized content');
    console.log('✓ repo map time, file, symbol, and output budgets');
    console.log('✓ repo_map tool is read-only and approximate');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
