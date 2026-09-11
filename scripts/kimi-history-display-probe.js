#!/usr/bin/env node
/**
 * سطر — مسبار عرض تاريخ Kimi الحقيقي (تشخيص OBS-153).
 * يقرأ أحدث جلسات Kimi لمجلد عبر المسار نفسه الذي تستخدمه الواجهة
 * (listSessions ثم readSession عبر ACP — قراءة فقط، بلا أدوار نموذج)، ويلخّص:
 * عدد الرسائل الكلي والمعروض، توزيع الأدوار، وعدد الرسائل التي ما زال فيها حقن
 * خام (satr:// أو system-reminder أو satr_project_memory أو satr_lang) بعد التنقية.
 * الاستخدام: npx electron scripts/kimi-history-display-probe.js [cwd] [عدد]
 */
'use strict';

const path = require('path');
const kimi = require(path.join(__dirname, '..', 'electron', 'kimi.js'));

const TARGET_CWD = process.argv[2] || 'D:\\sater\\satr-2';
const COUNT = Number(process.argv[3]) || 3;
const LEAK = /satr:\/\/|<system-reminder|<satr_project_memory|<satr_lang/;

(async () => {
  const sessions = await kimi.listSessions();
  const mine = sessions.filter((s) => {
    try { return path.resolve(s.cwd) === path.resolve(TARGET_CWD); } catch { return false; }
  });
  console.log('إجمالي جلسات Kimi:', sessions.length, '— للمجلد:', mine.length);
  for (const s of mine.slice(0, COUNT)) {
    const data = await kimi.readSession(s.id);
    if (data.error) { console.log('\n—', s.id, '| خطأ:', data.error); continue; }
    const roles = {};
    let leakedUser = 0, leakedAssistant = 0;
    for (const m of data.messages) {
      roles[m.role] = (roles[m.role] || 0) + 1;
      const t = m.text || JSON.stringify(m.content || []);
      if (LEAK.test(t)) { if (m.role === 'user') leakedUser++; else leakedAssistant++; }
    }
    console.log('\n—', s.id, '|', s.title);
    console.log('  total:', data.total, '| معروض:', data.messages.length,
      '| أدوار:', JSON.stringify(roles), '| حقن في رسائل المستخدم:', leakedUser, '| في المساعد:', leakedAssistant);
    for (const u of data.messages.filter((m) => m.role === 'user').slice(0, 4)) {
      console.log('  مستخدم:', JSON.stringify((u.text || '').slice(0, 70)));
    }
  }
  process.exit(0);
})().catch((e) => { console.error('فشل المسبار:', e); process.exit(1); });
