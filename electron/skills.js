/**
 * سطر 2.0 — سرد المهارات (Skills) المكتشَفة (قراءة فقط)
 *
 * يفحص مجلدي المهارات اللذين يكتشفهما Claude Agent SDK تلقائياً:
 *   - مهارات المشروع: <cwd>/.claude/skills/<اسم>/SKILL.md
 *   - مهارات المستخدم: ~/.claude/skills/<اسم>/SKILL.md
 * ويعيد لكل مهارة { name, description, source } لعرضها في لوحة /مهارات.
 * عند تكرار الاسم تفوز مهارة المشروع (تُفحص أولاً) — مطابقةً لسلوك Claude Code.
 *
 * هذا السرد للعرض فقط؛ الـ SDK نفسه يكتشف المهارات من القرص عند كل تشغيل.
 * تفعيل/تعطيل المهارات يتم عبر خيار `skills` الذي يمرّره agent.js (انظر main.js).
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');

const USER_SKILLS = path.join(os.homedir(), '.claude', 'skills');
const SAFE_DIR = /^[A-Za-z0-9._-]{1,80}$/; // اسم مجلد المهارة — مكوّن مسار واحد بلا فواصل
const HEAD_BYTES = 16 * 1024; // نقرأ رأس SKILL.md فقط (المقدمة name/description تظهر مبكراً)
const MAX_SKILLS = 200;

// تحليل مقدمة YAML البسيطة في رأس SKILL.md (key: value سطراً سطراً، بلا اعتماديات)
function parseFrontmatter(text) {
  const t = text.replace(/^﻿/, ''); // إزالة BOM إن وُجد
  const m = t.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

// يفحص مجلد مهارات واحداً ويضيف ما يجده إلى out (تجاهل المكرر بالاسم عبر seen)
async function scanDir(root, source, seen, out) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_SKILLS) return;
    if (!e.isDirectory() || !SAFE_DIR.test(e.name)) continue;
    const file = path.join(root, e.name, 'SKILL.md');
    let head = '';
    let fh = null;
    try {
      fh = await fsp.open(file, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      head = buf.toString('utf8', 0, bytesRead);
    } catch { continue; } // لا يوجد SKILL.md في هذا المجلد — ليس مهارة
    finally { if (fh) await fh.close().catch(() => {}); }
    const fm = parseFrontmatter(head) || {};
    const name = (typeof fm.name === 'string' && fm.name.trim()) ? fm.name.trim() : e.name;
    if (seen.has(name)) continue; // مهارة المشروع (فُحصت أولاً) تفوز بنفس الاسم
    seen.add(name);
    out.push({
      name,
      description: typeof fm.description === 'string' ? fm.description.trim().slice(0, 300) : '',
      source,
    });
  }
}

// قائمة المهارات المكتشَفة لمجلد المشروع المعطى + مهارات المستخدم. مرتبة أبجدياً.
async function listSkills(cwd) {
  const out = [];
  const seen = new Set();
  if (typeof cwd === 'string' && cwd.trim()) {
    await scanDir(path.join(cwd.trim(), '.claude', 'skills'), 'project', seen, out);
  }
  await scanDir(USER_SKILLS, 'user', seen, out);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

module.exports = { listSkills };
