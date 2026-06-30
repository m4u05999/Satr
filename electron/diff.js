/**
 * سطر 2.0 — حساب فروقات الأسطر (Diff) — المرحلة 3
 *
 * دالة نقية بلا اعتماديات: تقارن نص «قبل» بنص «بعد» وتعيد أسطراً موسومة
 * (سياق / إضافة / حذف) مع أرقام الأسطر وعدّاد الإضافات والحذف.
 *
 * الخوارزمية: قصّ البادئة واللاحقة المشتركة (يحلّ الحالة الشائعة — تعديل
 * موضعي — بسرعة خطية)، ثم LCS محدود الحجم على المنتصف لإنتاج فرق سطري دقيق،
 * ثم طيّ مساحات السياق الطويلة مع إبقاء أسطر حول كل تغيير.
 */

const MAX_LINES = 600;          // أقصى عدد أسطر معروضة في الفرق (الباقي يُطوى)
const CTX = 3;                  // أسطر السياق المُبقاة حول كل تغيير
const LCS_BUDGET = 400 * 400;   // سقف حجم مصفوفة LCS (وإلا fallback بسيط)

function splitLines(s) {
  return s.length ? s.split('\n') : [];
}

// فرق سطري لمنتصف غير مشترك عبر LCS (مع fallback عند تجاوز الميزانية)
function lcsMiddle(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((t) => ({ t: '+', text: t }));
  if (m === 0) return a.map((t) => ({ t: '-', text: t }));
  if (n * m > LCS_BUDGET) {
    // منتصف ضخم: نعرضه ككتلة حذف كاملة تليها كتلة إضافة كاملة (صحيح، أقل أناقة)
    return a.map((t) => ({ t: '-', text: t })).concat(b.map((t) => ({ t: '+', text: t })));
  }
  // جدول أطوال LCS (صفوف Uint32Array لاقتصاد الذاكرة)
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', text: a[i] }); i++; }
    else { ops.push({ t: '+', text: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: '-', text: a[i++] });
  while (j < m) ops.push({ t: '+', text: b[j++] });
  return ops;
}

/**
 * يحسب الفرق بين نصّين.
 * يعيد { added, removed, lines, truncated } حيث lines مصفوفة من:
 *   { t:' '|'-'|'+', text, old, new }   سطر عادي (old/new رقم السطر أو null)
 *   { t:'@' }                            علامة طيّ (أسطر مخفية)
 */
function computeDiff(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);

  // قصّ البادئة المشتركة
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  // قصّ اللاحقة المشتركة (دون تجاوز البادئة)
  let sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }

  // تجميع كامل الأسطر: بادئة (سياق) + منتصف مُفرَّق + لاحقة (سياق)
  const ops = [];
  for (let i = 0; i < p; i++) ops.push({ t: ' ', text: a[i] });
  for (const o of lcsMiddle(a.slice(p, sa), b.slice(p, sb))) ops.push(o);
  for (let i = sa; i < a.length; i++) ops.push({ t: ' ', text: a[i] });

  // ترقيم الأسطر + عدّ التغييرات (قبل الطيّ ليبقى العدّاد دقيقاً)
  let oldNo = 1, newNo = 1, added = 0, removed = 0;
  for (const o of ops) {
    if (o.t === ' ') { o.old = oldNo++; o.new = newNo++; }
    else if (o.t === '-') { o.old = oldNo++; o.new = null; removed++; }
    else { o.old = null; o.new = newNo++; added++; }
  }

  // أيّ سطر سياق ضمن CTX من تغيير يُبقى؛ الباقي يُطوى لعلامة واحدة
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].t !== ' ') {
      const lo = Math.max(0, i - CTX), hi = Math.min(ops.length - 1, i + CTX);
      for (let k = lo; k <= hi; k++) keep[k] = true;
    }
  }

  const lines = [];
  let gap = false, truncated = false;
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) {
      gap = false;
      lines.push(ops[i]);
      if (lines.length >= MAX_LINES) { truncated = true; break; }
    } else if (!gap) {
      gap = true;
      lines.push({ t: '@' });
    }
  }

  return { added, removed, lines, truncated };
}

module.exports = { computeDiff };
