#!/usr/bin/env node
/**
 * سطر — مسبار عرض تاريخ Codex الحقيقي (تشخيص OBS-153).
 * يقرأ عبر المسار نفسه الذي تستخدمه الواجهة (listCodexessions ثم readCodexSession
 * عبر thread/list وthread/read — قراءة فقط بلا أدوار نموذج) ويلخّص: عناوين اللوحة
 * بعد التنقية، وعدد رسائل المستخدم المعروضة، وما تبقى فيها من حقن خام.
 * الاستخدام: npx electron scripts/codex-history-display-probe.js [عدد]
 */
'use strict';

const path = require('path');
const codexsessions = require(path.join(__dirname, '..', 'electron', 'codexsessions.js'));

const COUNT = Number(process.argv[2]) || 3;
const LEAK = /satr:\/\/|<system-reminder|<satr_project_memory|<satr_lang|<recommended_plugins|<environment_context|# AGENTS\.md instructions/;

(async () => {
  const sessions = await codexsessions.listCodexSessions();
  console.log('جلسات Codex:', sessions.length);
  for (const s of sessions.slice(0, 8)) {
    console.log('  عنوان:', JSON.stringify(s.title.slice(0, 70)), LEAK.test(s.title) ? '⚠️ تسرّب' : '');
  }
  for (const s of sessions.slice(0, COUNT)) {
    const data = await codexsessions.readCodexSession(s.id);
    if (data.error) { console.log('\n—', s.id, '| خطأ:', data.error); continue; }
    const users = data.messages.filter((m) => m.role === 'user');
    const leaked = users.filter((m) => LEAK.test(m.text || '')).length;
    console.log('\n—', s.id, '|', s.title.slice(0, 50));
    console.log('  total:', data.total, '| معروض:', data.messages.length,
      '| مستخدم:', users.length, '| تسرّب فيها:', leaked);
    for (const u of users.slice(0, 4)) console.log('  مستخدم:', JSON.stringify((u.text || '').slice(0, 70)));
  }
  process.exit(0);
})().catch((e) => { console.error('فشل المسبار:', e); process.exit(1); });
