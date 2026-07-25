#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 300000;
const ROOT_MARKER = 'SATR_ROOT_BARRIER_OK';
const BRANCH_MARKERS = ['SATR_BRANCH_1_OK', 'SATR_BRANCH_2_OK', 'SATR_BRANCH_3_OK'];

async function main() {
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-codex-subagent-'));
  let handle = null;
  let completed = false;
  let timedOut = false;
  try {
    await fsp.writeFile(path.join(project, 'README.md'), '# Satr Codex subagent barrier probe\n', 'utf8');
    delete require.cache[require.resolve('../electron/codex')];
    const codex = require('../electron/codex');
    const finalTexts = [];
    const diagnostics = [];
    const permissionNames = [];
    const toolNames = [];
    const pendingPermissions = [];
    let result = null;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (handle && handle.stop) handle.stop().catch(() => {});
      finish();
    }, TIMEOUT_MS);

    handle = await codex.start({
      prompt: [
        'اختبار حتمي لحاجز الوكلاء الفرعيين. لا تستخدم shell أو MCP أو قراءة أو كتابة الملفات.',
        'استخدم أدوات collaboration الأصلية مباشرةً.',
        'أطلق في دفعة واحدة ثلاثة وكلاء معزولين فقط عبر spawn_agent وبـ fork_turns: "none".',
        'اطلب من الأول أن يعيد SATR_BRANCH_1_OK فقط، والثاني SATR_BRANCH_2_OK فقط، والثالث SATR_BRANCH_3_OK فقط.',
        'احتفظ بمعرّفاتهم وانتظر حتى تصل FINAL_ANSWER من الثلاثة. استدعاء wait_agent واحد ليس حاجزاً.',
        'لا تُنهِ دور الجذر بعد أول نتيجة ولا تعرض خرج طفل منفرد كإجابة نهائية.',
        'بعد اكتمال الثلاثة أجب بهذه الأسطر الأربعة فقط:',
        ROOT_MARKER,
        ...BRANCH_MARKERS,
      ].join('\n'),
      images: [],
      sessionId: null,
      model: process.env.SATR_CODEX_SUBAGENT_MODEL || 'gpt-5.6-sol',
      permissionMode: 'plan',
      skills: [],
      effort: 'medium',
      extraDirs: [],
      browserControl: false,
    }, project, (event) => {
      if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (block && block.type === 'text' && block.phase !== 'commentary') finalTexts.push(String(block.text || ''));
          if (block && block.type === 'tool_use') toolNames.push(String(block.name || ''));
        }
      }
      if (event.type === 'permission_request') {
        permissionNames.push(String(event.tool || ''));
        if (handle && handle.resolvePermission) handle.resolvePermission(event.id, false, false);
        else pendingPermissions.push(event);
      }
      if (event.type === 'stderr' || event.type === 'spawn_error') diagnostics.push(String(event.text || ''));
      if (event.type === 'result') result = event;
      if (event.type === 'proc_done' && !completed) {
        completed = true;
        finish();
      }
    });
    for (const event of pendingPermissions) handle.resolvePermission(event.id, false, false);
    await done;
    clearTimeout(timer);

    const finalText = finalTexts.join('\n');
    assert.strictEqual(timedOut, false, 'انتهت مهلة probe قبل اكتمال دور الجذر');
    assert(result && !result.is_error, 'فشل دور Codex: ' + diagnostics.join(' | '));
    assert(finalText.includes(ROOT_MARKER), 'لم تصل إجابة الجذر بعد حاجز الفروع');
    for (const marker of BRANCH_MARKERS) assert(finalText.includes(marker), 'غابت نتيجة فرع: ' + marker);
    assert(!finalTexts.some((text) => /^SATR_BRANCH_[123]_OK$/.test(text.trim())),
      'تسرّب خرج طفل منفرد كإجابة نهائية');
    assert.deepStrictEqual(permissionNames, [], 'ظهرت أذونات غير متوقعة: ' + permissionNames.join(', '));
    const waitCards = toolNames.filter((name) => name === 'Codex:wait').length;
    assert(waitCards >= 1, 'لم يثبت probe استخدام حاجز الانتظار: wait=' + waitCards);

    console.log(JSON.stringify({
      ok: true,
      model: process.env.SATR_CODEX_SUBAGENT_MODEL || 'gpt-5.6-sol',
      root_marker: true,
      branch_markers: BRANCH_MARKERS.length,
      wait_cards: waitCards,
      unexpected_permissions: permissionNames,
      tool_cards: toolNames,
      diagnostics,
    }, null, 2));
  } finally {
    if (!completed && handle && handle.stop) await handle.stop().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 800));
    await fsp.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
