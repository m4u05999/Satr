/**
 * سطر 2.0 — سرد الوكلاء الفرعيين (Subagents) المكتشَفين (قراءة فقط) — المرحلة 14.2
 *
 * يفحص مجلدي الوكلاء اللذين يحمّلهما Claude Agent SDK تلقائياً (عبر settingSources):
 *   - وكلاء المشروع: <cwd>/.claude/agents/<اسم>.md
 *   - وكلاء المستخدم: ~/.claude/agents/<اسم>.md
 * كل وكيل ملف Markdown واحد بمقدمة YAML (name/description/tools/model) وجسمه هو
 * برومبت النظام. يعيد لكل وكيل { name, description, tools, model, source } للوحة /وكلاء.
 * عند تكرار الاسم يفوز وكيل المشروع (يُفحص أولاً) — مطابقةً لسلوك Claude Code.
 *
 * هذا السرد للعرض فقط؛ الـ SDK يكتشف الوكلاء من القرص بنفسه، والنموذج يستدعيهم
 * بأداة الإطلاق (Task/Agent) التي تُعرض في الواجهة كبطاقة وكيل بأحداث متداخلة.
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');

const USER_AGENTS = path.join(os.homedir(), '.claude', 'agents');
const SAFE_FILE = /^[A-Za-z0-9._-]{1,80}\.md$/; // ملف وكيل — مكوّن مسار واحد بلا فواصل
const HEAD_BYTES = 16 * 1024;
const MAX_AGENTS = 100;

// تحليل مقدمة YAML البسيطة (key: value سطراً سطراً — نفس محلّل skills.js)
function parseFrontmatter(text) {
  const t = text.replace(/^﻿/, '');
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

// يفحص مجلد وكلاء واحداً ويضيف ما يجده إلى out (تجاهل المكرر بالاسم عبر seen)
async function scanDir(root, source, seen, out) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_AGENTS) return;
    if (!e.isFile() || !SAFE_FILE.test(e.name)) continue;
    let head = '';
    let fh = null;
    try {
      fh = await fsp.open(path.join(root, e.name), 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      head = buf.toString('utf8', 0, bytesRead);
    } catch { continue; }
    finally { if (fh) await fh.close().catch(() => {}); }
    const fm = parseFrontmatter(head) || {};
    const base = e.name.replace(/\.md$/, '');
    const name = (typeof fm.name === 'string' && fm.name.trim()) ? fm.name.trim() : base;
    if (seen.has(name)) continue; // وكيل المشروع (فُحص أولاً) يفوز بنفس الاسم
    seen.add(name);
    out.push({
      name,
      description: typeof fm.description === 'string' ? fm.description.trim().slice(0, 300) : '',
      tools: typeof fm.tools === 'string' && fm.tools.trim()
        ? fm.tools.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40)
        : [], // فارغة = يرث كل أدوات الجلسة
      model: typeof fm.model === 'string' ? fm.model.trim().slice(0, 60) : '',
      source,
    });
  }
}

// قائمة الوكلاء المكتشَفين لمجلد المشروع + وكلاء المستخدم. مرتبة أبجدياً.
async function listAgents(cwd) {
  const out = [];
  const seen = new Set();
  if (typeof cwd === 'string' && cwd.trim()) {
    await scanDir(path.join(cwd.trim(), '.claude', 'agents'), 'project', seen, out);
  }
  await scanDir(USER_AGENTS, 'user', seen, out);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

module.exports = { listAgents };
