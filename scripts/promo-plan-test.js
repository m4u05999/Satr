// حارس خطة الإعلان واقتراح الوكيل بحقول v2 — electron/promostudio.js (الدفعة 8 من مخرج الإعلانات).
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const studio = require('../electron/promostudio');

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

const scene = (extra) => ({ purpose: 'يثبت السرعة', steps_to_perform: ['افتح الصفحة', 'انقر «احجز»'], caption_ar: 'احجز في ثوانٍ', voiceover_ar: 'بضغطة واحدة.', duration_s: 6, ...extra });
const plan = (extra) => ({ goal: 'إبراز الحجز السريع', audience: 'أصحاب العيادات', duration_s: 30, aspect: '9:16', tone: 'واثقة', scenes: [scene()], ...extra });

// ── التنقية ──
const clean = studio.sanitizeAdPlan(plan());
eq(clean, { ok: true, plan: { goal: 'إبراز الحجز السريع', audience: 'أصحاب العيادات', duration_s: 30, aspect: '9:16', tone: 'واثقة', total_s: 6,
  scenes: [{ purpose: 'يثبت السرعة', steps_to_perform: ['افتح الصفحة', 'انقر «احجز»'], caption_ar: 'احجز في ثوانٍ', voiceover_ar: 'بضغطة واحدة.', duration_s: 6 }] } }, 'خطة صالحة');
eq(Object.keys(clean.plan).sort(), ['aspect', 'audience', 'duration_s', 'goal', 'scenes', 'tone', 'total_s'], 'لا حقول زائدة تعبر');
const noisy = studio.sanitizeAdPlan(plan({ goal: '  هدف\n\tبسطرين\u202E  ', duration_s: 500, aspect: '4:3', tone: 7, audience: null, command: 'rm -rf', path: 'C:\\x',
  scenes: [scene({ duration_s: 0, steps_to_perform: ['  خطوة  ', '', 5, 'ب'.repeat(500)], extra: 'x', asset: 'C:\\secret.mp4' })] })).plan;
eq([noisy.goal, noisy.duration_s, noisy.aspect, noisy.tone, noisy.audience], ['هدف بسطرين', 30, '16:9', '', ''], 'النص سطر واحد بلا محارف اتجاه، والقيم الخارجة تعود للافتراضي');
eq([noisy.scenes[0].duration_s, noisy.scenes[0].steps_to_perform.length, noisy.scenes[0].steps_to_perform[0], noisy.scenes[0].steps_to_perform[1].length], [5, 2, 'خطوة', 200], 'الخطوات تُنظَّف وتُقصّ');
ok(!('command' in noisy) && !('path' in noisy) && !('asset' in noisy.scenes[0]) && !('extra' in noisy.scenes[0]), 'لا مسار ولا أمر في الخطة');
eq(studio.sanitizeAdPlan(plan({ scenes: Array.from({ length: 20 }, () => scene({ steps_to_perform: Array.from({ length: 30 }, (_, i) => 'خطوة ' + i) })) })).error, 'bad_plan_scenes', 'أكثر من 12 مشهداً');
eq(studio.sanitizeAdPlan(plan({ scenes: [scene({ steps_to_perform: Array.from({ length: 30 }, (_, i) => 'خطوة ' + i) })] })).plan.scenes[0].steps_to_perform.length, 8, '8 خطوات على الأكثر');
for (const [label, value, error] of [['null', null, 'bad_plan'], ['نص', 'خطة', 'bad_plan'], ['مصفوفة', [], 'bad_plan'], ['بلا مشاهد', plan({ scenes: [] }), 'bad_plan_scenes'],
  ['مشاهد ليست مصفوفة', plan({ scenes: 'x' }), 'bad_plan_scenes'], ['مشهد ليس كائناً', plan({ scenes: ['x'] }), 'bad_plan_scenes'], ['مشهد مصفوفة', plan({ scenes: [[]] }), 'bad_plan_scenes'],
  ['بلا هدف', plan({ goal: '   ' }), 'bad_plan_goal'], ['هدف غير نصي', plan({ goal: 42 }), 'bad_plan_goal']]) {
  eq(studio.sanitizeAdPlan(value).error, error, 'مرفوض: ' + label);
}
const long = studio.sanitizeAdPlan(plan({ scenes: Array.from({ length: 4 }, () => scene({ duration_s: 60 })) }));
eq([long.ok, long.error, long.total_s], [false, 'bad_total_duration', 240], 'مجموع فوق 180 ثانية مرفوض');
eq(studio.sanitizeAdPlan(plan({ scenes: Array.from({ length: 3 }, () => scene({ duration_s: 60 })) })).plan.total_s, 180, '180 ثانية بالضبط مقبولة');
eq(studio.sanitizeAdPlan(plan({ scenes: [scene({ caption_ar: 'ع'.repeat(900), voiceover_ar: 'ص'.repeat(5000), purpose: 'غ'.repeat(900) })] })).plan.scenes[0], { purpose: 'غ'.repeat(200), steps_to_perform: ['افتح الصفحة', 'انقر «احجز»'], caption_ar: 'ع'.repeat(500), voiceover_ar: 'ص'.repeat(2000), duration_s: 6 }, 'النصوص تُقصّ عند حدودها');

// ── دورة الاقتراح والاعتماد ──
const events = [];
const controller = studio.create({ downloadsPath: os.tmpdir(), emit: (event) => events.push(event) });
eq(controller.adPlanState(), { ok: true, exists: false, approved: false, plan: null }, 'لا خطة في البداية');
eq(controller.planAd(plan({ goal: '' })).error, 'bad_plan_goal', 'خطة مرفوضة لا تُخزَّن');
eq([controller.adPlanState().exists, events.length], [false, 0], 'ولا تُبث');
const proposed = controller.planAd(plan());
eq([proposed.ok, proposed.approved, events.length, events[0].type], [true, false, 1, 'ad_plan_proposed'], 'الاقتراح يُبث ولا يُعتمد');
events[0].plan.goal = 'تلاعب';
eq(controller.adPlanState().plan.goal, 'إبراز الحجز السريع', 'ما يُبث نسخة لا مرجع');
const state = controller.adPlanState(); state.plan.scenes.length = 0;
eq(controller.adPlanState().plan.scenes.length, 1, 'وما يُقرأ نسخة لا مرجع');
eq(controller.approveAdPlan(plan({ goal: '' })).error, 'bad_plan_goal', 'نسخة المستخدم تُنقّى أيضاً');
eq(controller.adPlanState().approved, false, 'اعتماد مرفوض لا يغيّر الحالة');
const approved = controller.approveAdPlan(plan({ goal: 'هدف المستخدم', scenes: [scene({ caption_ar: 'عنوان المستخدم' }), scene({ duration_s: 9 })] }));
eq([approved.approved, controller.adPlanState().approved, controller.adPlanState().plan.goal, controller.adPlanState().plan.scenes.length, controller.adPlanState().plan.total_s], [true, true, 'هدف المستخدم', 2, 15], 'الاعتماد يحفظ نسخة المستخدم');
eq(events.length, 1, 'الاعتماد لا يبث اقتراحاً جديداً');
eq(controller.dismissAdPlan(), { ok: true }, 'الرفض');
eq(controller.adPlanState().exists, false, 'الرفض يزيل الخطة');

// ── مشاهد اقتراح الوكيل: الكاميرا تلقائية افتراضياً ──
eq(studio.proposalScenes([{ asset: 'a' }, { asset: 'b', camera: 'auto' }, { asset: 'c', camera: 'off' }, { asset: 'd', camera: { mode: 'manual', keyframes: [] } }, null, 'x']).map((item) => item && item.camera),
  [{ mode: 'auto', keyframes: [] }, { mode: 'auto', keyframes: [] }, { mode: 'off', keyframes: [] }, { mode: 'manual', keyframes: [] }, null, undefined], 'auto افتراضياً، off عند الطلب، والكائن كما هو');
eq(studio.proposalScenes('x'), 'x', 'مدخل ليس مصفوفة يمر للتنقية كي ترفضه');

// ── اقتراح بحقول v2 كاملة ──
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-plan-'));
try {
  const clip = path.join(downloads, 'clip.mp4'), voice = path.join(downloads, 'voice.wav');
  for (const file of [clip, voice]) fs.writeFileSync(file, 'x');
  const board = studio.create({ downloadsPath: downloads });
  const result = board.propose({ aspect: '9:16', scenes: studio.proposalScenes([
    { segment_path: clip, duration_ms: 5000, caption: 'Satr Pro متاح الآن', text_style: { animation: 'words', highlight: 'Pro' },
      stage: { frame: 'phone', background: { type: 'linear', color: '#101826', color2: '#d9a441' }, tilt: { x: 4, y: -14 } } },
    { segment_path: clip, duration_ms: 6000, transition_in: 'crossfade', voice, voiceover_ar: 'بضغطة واحدة تحجز موعدك.', subtitles: true, camera: 'off' },
  ]) });
  eq(result.ok, true, 'اقتراح v2 مقبول');
  const [first, second] = result.storyboard.scenes;
  eq([result.storyboard.aspect, first.camera.mode, first.camera.keyframes, first.text_style, first.stage.frame, first.stage.tilt], ['9:16', 'auto', [], { animation: 'words', font: 'plex', highlight: 'Pro' }, 'phone', { x: 4, y: -14 }], 'المشهد الأول');
  eq([second.camera.mode, second.transition_in, second.voice, second.voiceover_ar, second.subtitles, second.redactions], ['off', 'crossfade', voice, 'بضغطة واحدة تحجز موعدك.', true, []], 'المشهد الثاني');
  eq(board.propose({ scenes: studio.proposalScenes([{ segment_path: clip, duration_ms: 3000, camera: { mode: 'manual', keyframes: [{ t_ms: 0, x: 0.5, y: 0.5, zoom: 99 }] } }]) }).error, 'bad_camera', 'كاميرا خبيثة من الوكيل مرفوضة');
  eq(board.propose({ scenes: studio.proposalScenes(Array.from({ length: 4 }, () => ({ segment_path: clip, duration_ms: 60000 }))) }).error, 'bad_total_duration', 'اقتراح فوق 180 ثانية مرفوض');
  eq(board.propose({ scenes: studio.proposalScenes([{ segment_path: path.join(os.tmpdir(), 'outside.mp4'), duration_ms: 3000 }]) }).error, 'bad_asset', 'أصل خارج Downloads مرفوض');
} finally {
  fs.rmSync(downloads, { recursive: true, force: true });
}

console.log('promo-plan-test: ok — ' + checks + ' فحصاً (تنقية الخطة، دورة الاقتراح والاعتماد، الكاميرا التلقائية، اقتراح v2).');
