#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس حمية CLAUDE.md: **النواة تبقى نواة**.
 *
 * الدرس (خطة حمية الرموز، 2026-09-10): بلغ CLAUDE.md ‏476 ك.ب (‏4,279 سطراً) لأن كل دفعة
 * كانت تُوثَّق فيه، وهو يُحمَّل كاملاً في **كل** جلسة Claude Code وفي محرك SDK داخل سطر
 * (‏`settingSources` يشمل `project`) — أي ~100 ألف رمز قبل أول سؤال. تحذير Claude Code
 * الرسمي عند 40 ألف محرف، والتوصية ≤ 200 سطر. التفاصيل انتقلت إلى `docs/internals/`.
 *
 * ما يعضّ عليه: (١) حجم CLAUDE.md وعدد أسطره؛ (٢) وجود الإحالة إلى docs/internals؛
 * (٣) فهرس internals يذكر كل ملف NN-*.md وكل ملف مذكور موجود ويبدأ بعنوان؛
 * (٤) قواعد `.claude/rules/*.md` تحمل `paths:` وكل إحالة فيها إلى ملف موجود؛
 * (٥) لا يعود قسم «## المعمارية» المفصّل إلى CLAUDE.md (لا `### ` تحته إلا «أين التفاصيل»).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md');
const INTERNALS = path.join(ROOT, 'docs', 'internals');
const RULES = path.join(ROOT, '.claude', 'rules');

const MAX_CHARS = 40000; // عتبة تحذير Claude Code
const MAX_LINES = 240;   // التوصية 200 مع هامش للنواة العربية الكثيفة

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

const text = fs.readFileSync(CLAUDE_MD, 'utf8');
const lines = text.split('\n');
ok(text.length <= MAX_CHARS, `CLAUDE.md ${text.length} محرفاً > الحدّ ${MAX_CHARS} — انقل التفاصيل إلى docs/internals`);
ok(lines.length <= MAX_LINES, `CLAUDE.md ${lines.length} سطراً > الحدّ ${MAX_LINES}`);
ok(/docs\/internals\/README\.md/.test(text), 'CLAUDE.md يحيل إلى docs/internals/README.md');
ok(/test:claude-md-size/.test(text), 'CLAUDE.md يذكر حارسه');
const h3 = lines.filter((l) => l.startsWith('### '));
ok(h3.length <= 1, `عادت أقسام تفصيلية (###) إلى CLAUDE.md: ${h3.length} — مكانها docs/internals`);

// الفهرس والملفات
const files = fs.readdirSync(INTERNALS).filter((f) => /^\d{2}-.*\.md$/.test(f)).sort();
ok(files.length >= 60, `docs/internals فيه ${files.length} ملفاً فقط — هل ضاع النقل؟`);
const readme = fs.readFileSync(path.join(INTERNALS, 'README.md'), 'utf8');
for (const file of files) {
  ok(readme.includes(`(${file})`), `الفهرس لا يذكر ${file}`);
  const first = fs.readFileSync(path.join(INTERNALS, file), 'utf8').split('\n')[0];
  ok(/^#{2,3} /.test(first), `${file} لا يبدأ بعنوان`);
}
for (const match of readme.matchAll(/\]\(([0-9]{2}-[^)]+\.md)\)/g)) {
  ok(fs.existsSync(path.join(INTERNALS, match[1])), `الفهرس يذكر ملفاً غير موجود: ${match[1]}`);
}

// القواعد المسارية
const rules = fs.readdirSync(RULES).filter((f) => f.endsWith('.md'));
ok(rules.length >= 8, `قواعد .claude/rules قليلة: ${rules.length}`);
for (const rule of rules) {
  const body = fs.readFileSync(path.join(RULES, rule), 'utf8');
  ok(/^---\npaths:\n(?:  - ".+"\n)+---\n/.test(body), `${rule} بلا ترويسة paths صالحة`);
  for (const ref of body.matchAll(/`docs\/internals\/([^`]+)`/g)) {
    ok(fs.existsSync(path.join(INTERNALS, ref[1])), `${rule} يحيل إلى ملف غير موجود: ${ref[1]}`);
  }
  ok(body.length < 4000, `${rule} أكبر من مؤشّرات (${body.length} محرفاً) — القواعد إحالات لا نصوص`);
}

console.log(`claude-md-size-test: ok — ${checks} فحصاً؛ CLAUDE.md ${lines.length} سطراً / ${text.length} محرفاً؛ internals ${files.length} ملفاً؛ rules ${rules.length}`);
