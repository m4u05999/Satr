'use strict';
// مشغّل قياس للنافذة الرئيسية المعزولة، لا حارس نجاح/فشل ولا بديل للقبول البشري.
// لا ينقر ولا يبدل العرض: يقرأ الحالة التي جهّزها قائد التجربة. تُؤخذ قراءة لكل عرض.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./lib/live-test-run');
const { connectMain } = require('./lib/live-test-client');
const repo = path.resolve(__dirname, '..');

function productionReadabilityScript() {
  const source = fs.readFileSync(path.join(repo, 'electron', 'preview.js'), 'utf8');
  const marker = 'const READABILITY_FN = ' + String.fromCharCode(96);
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('missing_production_readability_script');
  const open = start + marker.length - 1;
  const close = source.indexOf(String.fromCharCode(96) + ';', open + 1);
  if (close < 0) throw new Error('unterminated_production_readability_script');
  const raw = source.slice(open + 1, close);
  if (raw.includes(String.fromCharCode(36) + '{')) throw new Error('unexpected_script_interpolation');
  // يحل V8 الهروب تماماً مثل تعريف الثابت الإنتاجي؛ لا تعديل في جسم المسبار.
  return new Function('return ' + String.fromCharCode(96) + raw + String.fromCharCode(96) + ';')();
}

function readState() {
  const panel = document.getElementById('settingsPop');
  const bounds = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
  };
  const blocks = 'p,li,h1,h2,h3,h4,h5,h6,td,th,dd,dt,blockquote,figcaption,caption,summary,label,legend';
  const rect = bounds(panel);
  return {
    viewport: {width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
    settings: {
      exists:!!panel, visible:!!panel && panel.checkVisibility({visibilityProperty:true}),
      hidden:!!panel && panel.hidden, rect,
      scrollTop:panel ? panel.scrollTop : null,
      clientHeight:panel ? panel.clientHeight : null,
      scrollHeight:panel ? panel.scrollHeight : null,
      clientWidth:panel ? panel.clientWidth : null,
      scrollWidth:panel ? panel.scrollWidth : null,
      semanticBlocks:panel ? panel.querySelectorAll(blocks).length : 0,
      viewportClipped:!!rect && (rect.left<0 || rect.right>innerWidth || rect.top<0 || rect.bottom>innerHeight),
    },
    theme:document.documentElement.dataset.theme || 'dark',
    documentVisibility:document.visibilityState,
    documentFocused:document.hasFocus(),
    fontStatus:document.fonts.status,
  };
}

async function main() {
  const [id, label = 'current'] = process.argv.slice(2);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(label)) throw new Error('invalid_label');
  const run = core.loadRun(repo, id);
  const probe = productionReadabilityScript();
  const client = await connectMain(repo, id);
  try {
    const expression = '(' + readState.toString() + ')()';
    const before = await client.evaluate(expression);
    if (!before.settings.visible || before.settings.hidden) throw new Error('settings_must_be_open');
    const readability = await client.evaluate(probe);
    if (!readability || !readability.counts || !readability.unseen
      || typeof readability.truncated !== 'boolean') throw new Error('invalid_readability_report');
    const after = await client.evaluate(expression);
    const stableViewport = before.viewport.width === after.viewport.width
      && before.viewport.height === after.viewport.height;
    const record = {
      timestamp:new Date().toISOString(), runId:id, label, mode:'source', measurementCompleted:true,
      execution: {
        kind:'production-readability-script-via-main-window-cdp',
        scriptSource:'electron/preview.js:READABILITY_FN',
        scriptSha256:crypto.createHash('sha256').update(probe).digest('hex'),
        scriptBytes:Buffer.byteLength(probe, 'utf8'),
        world:'main renderer via Runtime.evaluate', officialToolCalled:false,
      },
      before, after, stableViewport, readability,
      limits: [
        'شُغّل نفس مسبار browser_readability عبر CDP في النافذة الرئيسية؛ لم تُستدع الأداة على لوحة المعاينة.',
        'الأداة الأصلية تشغّل المسبار في عالم معزول، وهذا المشغّل يستخدم عالم renderer الرئيسي عبر connectMain.',
        'التقرير يقيس light DOM للنافذة كلها مع فتح الإعدادات؛ العدادات لا تخص الإعدادات وحدها.',
        'Shadow DOM وiframe خارج القياس، وكذلك النصوص المجردة في div/span/button والعناصر القصيرة التي لا يغطيها المسبار.',
        'نجاح جمع التقرير لا يعني صفراً من المخالفات أو قبولاً بصرياً؛ counts وunseen وtruncated هي الدليل.',
        'المشغّل لم ينقر أو يغير الحجم أو اتجاه النص؛ يُجهز العرض الآخر خارج هذا المشغّل ثم تؤخذ قراءة جديدة.',
      ],
    };
    const dir = path.join(run.paths.root, 'models-surfaces');
    fs.mkdirSync(dir, {recursive:true});
    const file = path.join(dir, 'readability-' + label + '-' + after.viewport.width + '-' + Date.now() + '.json');
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', {encoding:'utf8',flag:'wx'});
    console.log(JSON.stringify({
      report:file, viewport:readability.viewport, settings:after.settings, stableViewport,
      counts:readability.counts, unseen:readability.unseen, truncated:readability.truncated,
      scanned:readability.scanned, totalFindings:readability.total_findings, limits:record.limits,
    }, null, 2));
    if (!stableViewport || !after.settings.visible) process.exitCode = 1;
  } finally { client.close(); }
}
if (require.main === module) main().catch((error) => {
  console.error('models-surfaces-readability: ' + (error && error.message || 'failed'));
  process.exitCode = 1;
});
module.exports = { productionReadabilityScript };
