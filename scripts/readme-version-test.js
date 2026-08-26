#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس مزامنة رقم الإصدار في README (‏OBS-054، قطعي بلا شبكة).
 *
 * يحرس ثلاثة أشياء، أخطرها الثاني:
 *   1. أن التعفّن يُمسَك (وهو العطل الأصلي: 404 في أمر التنزيل سبعة إصدارات).
 *   2. أن **الأرقام التاريخية لا تُمسّ** — README يحمل حدَّ رخصة MIT وتاريخ دمج
 *      التحديث التلقائي. سكربتٌ يستبدل «كل semver» كان سيُعيد كتابة تاريخ
 *      الترخيص بصمت، وهو ضررٌ أكبر من العطل الذي يعالجه.
 *   3. أن الوصل قائم فعلاً: خطّاف `npm version` ووظيفة الإصدار عند الوسم — وإلا
 *      كان السكربت «موصولاً لكن غير مربوط» فيعود الاعتماد على تذكيرٍ بشري.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const sync = require('./sync-readme-version');

let checks = 0;
function ok(cond, msg) { checks += 1; assert(cond, msg); }

const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const VERSION = sync.readVersion();

// ── 1) الحالة الراهنة متزامنة، والمواضع المعروفة كلها مرصودة ────────────────
{
  const found = sync.scan(README);
  ok(found.length >= 7, 'المواضع الديناميكية سبعة على الأقل (وُجد ' + found.length + ')');
  ok(found.every((item) => item.version === VERSION),
    'وREADME متزامن مع package.json — وإلا فالإصدار القادم يُنشر برابط مكسور');
  const anchors = new Set(found.map((item) => item.anchor));
  ok(anchors.has('شارة الإصدار') && anchors.has('اسم المثبّت'),
    'والشارة واسم المثبّت مرصودان — وهما وجه المشروع وأمر تنزيله');
}

// ── 2) الأرقام التاريخية لا تُمسّ — أخطر ما في هذا السكربت ──────────────────
{
  // ليست مخترعة: هي في README اليوم، ومعناها تاريخيٌّ لا يتحرك مع الإصدار.
  const HISTORICAL = [
    ['منذ 2.4.1', 'تاريخ دمج التحديث التلقائي'],
    ['v2.10.0', 'آخر إصدار تحت رخصة MIT'],
    ['v2.14.0', 'بداية الرخصة الجديدة'],
  ];
  for (const [needle, why] of HISTORICAL) {
    ok(README.includes(needle), 'المرجع التاريخي «' + needle + '» (' + why + ') موجود في README');
  }
  // إعادة الكتابة برقم مختلف تماماً يجب ألّا تمسّها
  const rewritten = sync.rewrite(README, '9.9.9');
  for (const [needle, why] of HISTORICAL) {
    ok(rewritten.includes(needle),
      'إعادة الكتابة أتلفت المرجع التاريخي «' + needle + '» (' + why + ') — '
        + 'ضررٌ أكبر من العطل الذي يعالجه السكربت');
  }
  ok(!/badge\/version-(?!9\.9\.9)/.test(rewritten), 'بينما الشارة تحرّكت فعلاً');
  ok(rewritten.includes('Satr-Setup-9.9.9.exe'), 'واسم المثبّت كذلك');
}

// ── 3) التعفّن يُمسَك، والمزامنة عكسية تماماً (idempotent) ──────────────────
{
  const rotted = sync.rewrite(README, '2.16.0'); // الحالة الحقيقية قبل v2.16.9
  const stale = sync.scan(rotted).filter((item) => item.version !== VERSION);
  ok(stale.length >= 7, 'التعفّن يُرصد في كل المواضع (' + stale.length + ')');
  ok(sync.rewrite(rotted, VERSION) === README,
    'والمزامنة تعيد الملف مطابقاً بايتاً — لا تشويه جانبي');
  ok(sync.rewrite(README, VERSION) === README, 'وتشغيلها على متزامن لا يغيّر شيئاً');
}

// ── 4) الوصل — «موصول لكن غير مربوط» هو شكل هذا العطل نفسه ─────────────────
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok(/sync-readme-version\.js/.test(manifest.scripts.version || ''),
    'خطّاف `npm version` يستدعي المزامنة — وإلا بقي الرقم يدوياً كما كان');
  ok(/git add README\.md/.test(manifest.scripts.version || ''),
    'ويضيف README إلى الالتزام — بلا ذلك يُحدَّث الملف ويبقى خارج الالتزام');

  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  ok(/sync-readme-version\.js --check/.test(workflow), 'ووظيفة الإصدار تفحص المزامنة');
  // الموضع مقصود: بين الإصدارات يكون README على الرقم المنشور وpackage.json مرفوعاً
  const releaseJob = workflow.slice(workflow.indexOf("if: startsWith(github.ref, 'refs/tags/v')"));
  ok(releaseJob.includes('sync-readme-version.js --check'),
    'والفحص داخل وظيفة الوسم لا في التحقق الخفيف — وإلا كسر CI على عمل سليم بين الإصدارات');
}

console.log('readme-version-test: ok — ' + checks
  + ' فحصاً (التعفّن يُمسَك، والأرقام التاريخية سليمة، والمزامنة عكسية، والوصل قائم).');
