/*
 * silhouetteOverride.js
 * ─────────────────────────────────────────────────────────────
 * Loads optional pre-baked horizon traces from assets/overrides/
 * and swaps them in for the detector's output in the analysis
 * pipeline. Lets us ship a hand-tuned Mt Rainier without touching
 * the detection algorithm itself.
 *
 * Override JSON format (produced by the dev editor tool that used
 * to live here — now removed after the overrides were baked):
 *   {
 *     sampleId:  "mountains",
 *     width:     2340,           // canvas width the override was captured at
 *     height:    804,
 *     silhouette: number[],      // y-per-column in 0..1 (1 = top)
 *     version:   1,
 *     createdAt: "..."
 *   }
 *
 * Profiles captured at a different canvas width than the current
 * render get linearly resampled on load — good enough; horizons
 * don't carry sub-pixel detail the pipeline cares about.
 */

window.SilhouetteOverride = (() => {
  // sampleId → { silhouette, width, height } | null (absent)
  const cache = new Map();

  async function preload(sampleId) {
    if (!sampleId) return null;
    if (cache.has(sampleId)) return cache.get(sampleId);
    try {
      const res = await fetch(`assets/overrides/${sampleId}.override.json`, {
        cache: 'force-cache',
      });
      if (!res.ok) { cache.set(sampleId, null); return null; }
      const obj = await res.json();
      if (!obj || !Array.isArray(obj.silhouette)) { cache.set(sampleId, null); return null; }
      cache.set(sampleId, obj);
      return obj;
    } catch (e) {
      cache.set(sampleId, null);
      return null;
    }
  }

  function resample(src, toW) {
    const fromW = src.length;
    if (fromW === toW) return new Float32Array(src);
    const out = new Float32Array(toW);
    for (let i = 0; i < toW; i++) {
      const t = i / (toW - 1);
      const idx = t * (fromW - 1);
      const a = Math.floor(idx);
      const b = Math.min(fromW - 1, a + 1);
      const frac = idx - a;
      out[i] = src[a] * (1 - frac) + src[b] * frac;
    }
    return out;
  }

  /*
   * Given a sample id and the detector's output, return what the
   * pipeline should actually use. Falls back to the detection if
   * no override is cached (i.e. preload() hasn't run or the fetch
   * returned 404). The `used` flag is for logging / UI debugging.
   */
  function applyIfPresent(sampleId, detectedProfile, currentW) {
    const over = cache.get(sampleId);
    if (!over) return { profile: detectedProfile, used: false };
    const arr = new Float32Array(over.silhouette);
    const profile = arr.length === currentW ? arr : resample(arr, currentW);
    return { profile, used: true };
  }

  return { preload, applyIfPresent, resample };
})();
