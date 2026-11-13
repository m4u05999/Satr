// الخط الزمني المطلق للإعلان: دوال نقية بلا DOM، تُختبر بـnode.
// المصدر الواحد لحدود المشاهد؛ المعاينة والتصدير يقرآن منه كي لا يختلفا عند الحواف.

// سقف مجموع مدد المشاهد (القيد 8 في docs/PROMO-DIRECTOR-PLAN.md).
export const MAX_TOTAL_MS = 180000;

export function buildTimeline(storyboard) {
  const raw = storyboard && Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  const scenes = [];
  let cursor = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const scene = raw[index];
    const duration = scene && Number.isFinite(scene.duration_ms) && scene.duration_ms > 0 ? scene.duration_ms : 0;
    if (!duration) continue;
    const trim = Number.isFinite(scene.trim_start_ms) && scene.trim_start_ms > 0 ? scene.trim_start_ms : 0;
    scenes.push({ index, scene, startMs: cursor, endMs: cursor + duration, durationMs: duration, sourceStartMs: trim });
    cursor += duration;
  }
  return { totalMs: cursor, scenes, overLimit: cursor > MAX_TOTAL_MS };
}

// المشهد عند زمن مطلق. نهاية الإعلان نفسها تُنسب إلى آخر مشهد عند آخر لحظة فيه.
export function sceneAt(timeline, tMs) {
  const scenes = timeline && timeline.scenes;
  if (!scenes || !scenes.length || !Number.isFinite(tMs)) return null;
  const time = Math.max(0, tMs);
  for (const entry of scenes) {
    if (time >= entry.startMs && time < entry.endMs) {
      return { entry, localMs: time - entry.startMs, sourceMs: entry.sourceStartMs + time - entry.startMs };
    }
  }
  const last = scenes[scenes.length - 1];
  return { entry: last, localMs: last.durationMs, sourceMs: last.sourceStartMs + last.durationMs };
}

// عدد إطارات التصدير وزمن كل إطار: الإطار i عند i × 1000/fps بالضبط، بلا تراكم أخطاء تقريب.
export function frameCount(totalMs, fps) {
  return Math.round(totalMs * fps / 1000);
}

export function frameTimeMs(index, fps) {
  return index * 1000 / fps;
}

// عتامة غطاء التلاشي عند بداية المشهد ونهايته (0 = لا غطاء).
export function fadeOpacity(transition, localMs, durationMs) {
  if (transition !== 'fade') return 0;
  const edge = Math.min(500, durationMs / 3);
  if (localMs < edge) return 1 - localMs / edge;
  if (localMs > durationMs - edge) return 1 - (durationMs - localMs) / edge;
  return 0;
}
