/**
 * قارئ صناديق ISO-BMFF العام — وحدة نقية بلا اعتماديات، تعمل في المتصفح وفي node.
 *
 * يستعملها `source-mp4.js` (قراءة الرؤوس) والاختبارات (التحقق من البنية الفعلية للملف).
 * لا تعرف شيئاً عن معنى الصناديق؛ تعرف فقط: الرأس (الحجم والنوع) وحجم 64-بت والحجم 0
 * (يمتد للنهاية) والتكرار على الأبناء في الحاويات المعروفة.
 *
 * كل الإزاحات **مطلقة داخل المصفوفة** المُمرَّرة. المستدعي الذي يقرأ جزءاً من ملف
 * يحوّل الإزاحات بنفسه.
 */

/** الحاويات التي يُنزل فيها المشي إلى أبنائها (مجموعة افتراضية). */
export const DEFAULT_CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf', 'udta',
]);

/** يحوّل أي Uint8Array (حتى لو كان شريحة من مخزن أكبر) إلى DataView صحيح الحدود. */
export function viewOf(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('المدخل ليس Uint8Array');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** نوع الصندوق رباعي الأحرف ASCII عند الإزاحة. */
export function readFourCC(view, offset) {
  if (offset + 4 > view.byteLength) throw new RangeError('نوع الصندوق خارج الحدود عند ' + offset);
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
}

/** عدد 64-بت يُرفض إن تجاوز الدقة الصحيحة في JavaScript. */
export function readU64(view, offset) {
  const hi = view.getUint32(offset);
  const lo = view.getUint32(offset + 4);
  const value = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(value)) throw new RangeError('قيمة 64-بت تتجاوز الدقة الآمنة عند ' + offset);
  return value;
}

/**
 * يقرأ رأس صندوق يبدأ عند `offset` ولا يتجاوز `limit`.
 * يرمي خطأً عربياً إن كان الحجم أصغر من الرأس أو يتجاوز الحاوية: الملف مشوَّه ولا تخمين.
 * @returns {{type:string, start:number, size:number, header:number, bodyStart:number, end:number}}
 */
export function readBoxHeader(view, offset, limit = view.byteLength) {
  if (offset + 8 > limit) throw new RangeError('رأس صندوق مقطوع عند ' + offset);
  let size = view.getUint32(offset);
  const type = readFourCC(view, offset + 4);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > limit) throw new RangeError('رأس 64-بت مقطوع عند ' + offset);
    size = readU64(view, offset + 8);
    header = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < header) throw new RangeError(`صندوق «${type}» حجمه ${size} أصغر من رأسه عند ${offset}`);
  if (offset + size > limit) throw new RangeError(`صندوق «${type}» عند ${offset} يتجاوز حاويته`);
  return { type, start: offset, size, header, bodyStart: offset + header, end: offset + size };
}

/**
 * مشي متكرر على الصناديق بين `start` و`end`. يستدعي `visit(box, depth)` لكل صندوق
 * (قبل النزول إلى أبنائه). الأبناء تُزار فقط لأنواع في `containers`.
 */
export function walkBoxes(bytesOrView, start, end, visit, options = {}) {
  const view = bytesOrView instanceof DataView ? bytesOrView : viewOf(bytesOrView);
  const containers = options.containers || DEFAULT_CONTAINERS;
  const depth = options.depth || 0;
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(view, offset, end);
    visit(box, depth);
    if (containers.has(box.type)) walkBoxes(view, box.bodyStart, box.end, visit, { containers, depth: depth + 1 });
    offset = box.end;
  }
  return offset;
}

/**
 * يعيد الحقول الأساسية لصندوق كامل (FullBox): الإصدار والأعلام وبداية الجسم بعدهما.
 */
export function readFullBoxHead(view, bodyStart) {
  const word = view.getUint32(bodyStart);
  return { version: word >>> 24, flags: word & 0xffffff, next: bodyStart + 4 };
}
