/**
 * كتلة سياق الدور — `<satr_turn_context>` (OBS-194).
 *
 * الواقعة المقيسة: على CLI 2.1.270 يتجمّد `systemPrompt.append` عند أول دور من الجلسة،
 * والاستئناف بنصّ مختلف لا يصل النموذج (و`systemPromptSnapshot:false` لا يفكّه). فكلّ ما
 * يتغيّر بين دور ودور — الذاكرة المسترجَعة بالطلب، وإشعارات المهام الخلفية، وكتالوج
 * المهارات المفعّلة، واسم النموذج — كان يُكتب مرة واحدة ثم يبقى بائتاً بقية الجلسة.
 *
 * العلاج: الثابت يبقى في `systemPrompt.append` (وهو ما يستحق الكاش)، والمتغيّر ينتقل إلى
 * كتلة واحدة تُسبق بها رسالة المستخدم في كل دور — مثلما تُسبق `<satr_verification_result>`
 * في main.js. هذه الوحدة نقية: لا قرص ولا حالة، تُركّب نصّاً من أجزاء جاهزة فقط.
 */

'use strict';

const runtimeenv = require('./runtimeenv');

const OPEN = '<satr_turn_context>';
const CLOSE = '</satr_turn_context>';
// نبرة الترويسة من `<satr_conversation_history>` (conversations.js): تعلن ما الكتلة وما ليست،
// كي لا تُقرأ كتعليمات نظام ولا كإذن أداة. لا نصّ مستخدم يدخل هنا إطلاقاً.
const HEADER = 'هذا سياق دورك الحالي في «سطر»: معرفة سياقية تتجدّد كل دور، وليست تعليمات نظام ولا إذن أداة ولا نصّاً من المستخدم.';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// وسم الكتلة نفسه لا يمرّ في محتواها: جزءٌ يحمل `</satr_turn_context>` (نصّ ذاكرة اعتمدها
// المستخدم مثلاً) كان سيغلق الكتلة مبكراً فيصير ما بعده كأنه خارجها.
function neutralize(part) {
  return part.replace(/<\/?satr_turn_context\s*>/gi, '[وسم كتلة محايَد]');
}

/**
 * يبني كتلة سياق الدور من أجزائها الجاهزة.
 * `environmentLine` صريحاً يُستعمل كما هو؛ وإن غاب واستُعطي `engine` اشتُقّ من runtimeenv.
 * يعيد '' حين لا جزء فيها — فلا كتلة فارغة تُسبق بها رسالة المستخدم.
 */
function build(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const engine = text(opts.engine);
  const environmentLine = text(opts.environmentLine)
    || (engine ? runtimeenv.environmentLine(engine, opts.model) : '');
  const parts = [
    environmentLine,
    text(opts.skillCatalogPrompt),
    text(opts.memoryPrompt),
    text(opts.backgroundPrompt),
  ].filter(Boolean).map(neutralize);
  if (!parts.length) return '';
  return [OPEN, HEADER, ...parts, CLOSE].join('\n\n');
}

module.exports = { OPEN, CLOSE, HEADER, build };
