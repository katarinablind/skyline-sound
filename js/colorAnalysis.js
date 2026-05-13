/**
 * Color → musical parameter analysis.
 *
 * Extracts dominant color palette from an image canvas, then maps:
 *   hue        → mode (Ionian / Dorian / ... / Aeolian / Phrygian)
 *   saturation → scale richness (pentatonic vs. 7-note)
 *   lightness  → base octave (register center)
 *   warmth     → tempo nudge (±8 BPM around 68)
 */

const ColorAnalysis = (() => {

  /* ── Extract top-N raw-frequency dominants (for analysis) ───
   * Used for the tonal analysis (mode/root/octave). Always raw
   * frequency, no vibrance weighting — this is about "what colors
   * dominate the pixels," which is how we key the image's mood.
   */
  function _extractBucketsRaw(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    const stepX = Math.max(1, Math.floor(w / 60));
    const stepY = Math.max(1, Math.floor(h / 60));
    let total = 0;
    const bucket = new Map();
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        const entry = bucket.get(key);
        if (entry) {
          entry[0] += r; entry[1] += g; entry[2] += b; entry[3]++;
        } else {
          bucket.set(key, [r, g, b, 1]);
        }
        total++;
      }
    }
    return { buckets: [...bucket.values()], total };
  }

  function extractDominants(canvas, k = 3) {
    const { buckets, total } = _extractBucketsRaw(canvas);
    return buckets
      .sort((a, b) => b[3] - a[3])
      .slice(0, k)
      .map(([r, g, b, n]) => ({
        r: Math.round(r / n),
        g: Math.round(g / n),
        b: Math.round(b / n),
        weight: n / total,
      }));
  }

  /* ── Extract palette: dominants + accents, RGB-distance deduped ──
   *
   * Two problems a naive "top-k by count" approach has:
   *   1. Near-duplicate dark colors (e.g. four slightly different near-
   *      blacks in a forest shot) crowd out everything else.
   *   2. Small but vivid accents (a sunset pink, a neon sign) never
   *      surface because their bucket count is tiny.
   *
   * We solve both with a single greedy pass:
   *   - Rank every bucket by a blended score (count + vibrance).
   *   - Walk the list; only add a bucket if it is at least MIN_DIST away
   *     (RGB Euclidean) from every already-picked swatch.
   *   - If, after that pass, we still have slots, do a second pass purely
   *     on vibrance (so a faint-but-colorful accent still gets a seat).
   */

  function extractPalette(canvas, k = 5) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;

    // Sample grid
    const stepX = Math.max(1, Math.floor(w / 60));
    const stepY = Math.max(1, Math.floor(h / 60));
    let totalSamples = 0;
    const bucket = new Map();
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        const entry = bucket.get(key);
        if (entry) {
          entry[0] += r; entry[1] += g; entry[2] += b; entry[3]++;
        } else {
          bucket.set(key, [r, g, b, 1]);
        }
        totalSamples++;
      }
    }

    // Annotate every bucket with HSL + a vibrance score
    const all = [...bucket.values()].map(([rs, gs, bs, n]) => {
      const r = rs / n, g = gs / n, b = bs / n;
      const hsl = rgbToHsl(r, g, b);
      const midLight = Math.min(hsl.l, 1 - hsl.l) * 2; // 0 at black/white, 1 at mid-grey
      const vibrance = n * Math.max(0, hsl.s - 0.12) * (0.3 + midLight * 0.7);
      return {
        r: Math.round(r), g: Math.round(g), b: Math.round(b),
        count: n,
        weight: n / totalSamples,
        h: hsl.h, s: hsl.s, l: hsl.l,
        vibrance,
      };
    });

    if (all.length === 0) return [];

    // RGB Euclidean distance in 0..255 space
    const dist = (a, b) => {
      const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    };
    const farEnough = (c, picks, min) =>
      picks.every(p => dist(c, p) >= min);

    // Normalize count & vibrance to comparable scales, then blend
    const maxCount = all.reduce((m, c) => Math.max(m, c.count), 1);
    const maxVib   = all.reduce((m, c) => Math.max(m, c.vibrance), 1e-6);
    const scored = all.map(c => ({
      ...c,
      score: (c.count / maxCount) * 0.55 + (c.vibrance / maxVib) * 0.45,
    }));

    const MIN_DIST = 45;    // ≈ perceptibly different color
    const picks = [];

    // Pass 1: by blended score, require MIN_DIST separation
    const byScore = [...scored].sort((a, b) => b.score - a.score);
    for (const c of byScore) {
      if (picks.length >= k) break;
      if (farEnough(c, picks, MIN_DIST)) picks.push(c);
    }

    // Pass 2 (fallback): if fewer than k, relax distance to fill slots
    // using the most vivid remaining colors. Prevents empty swatches on
    // monochrome images while still favoring variety.
    if (picks.length < k) {
      const byVibrance = [...scored].sort((a, b) => b.vibrance - a.vibrance);
      for (const c of byVibrance) {
        if (picks.length >= k) break;
        if (picks.includes(c)) continue;
        if (farEnough(c, picks, MIN_DIST * 0.55)) picks.push(c);
      }
    }

    // Sort visually by lightness descending so swatches read pleasantly
    picks.sort((a, b) => b.l - a.l);
    return picks.slice(0, k);
  }

  /* ── RGB → HSL ───────────────────────────────────────── */

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h, s;
    if (max === min) { h = 0; s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = ((b - r) / d + 2); break;
        case b: h = ((r - g) / d + 4); break;
      }
      h *= 60;
    }
    return { h, s, l };
  }

  /* ── Hue → musical mode ──────────────────────────────── */
  /*
   *    0°  red        → Lydian (bright, warm)
   *   30°  orange     → Mixolydian (warm, bluesy-major)
   *   60°  yellow     → Major (Ionian, radiant)
   *  120°  green      → Dorian (balanced)
   *  180°  cyan       → Mixolydian
   *  210°  blue       → Minor (Aeolian, introspective)
   *  270°  purple     → Phrygian (dark)
   *  330°  magenta    → Lydian
   */
  function hueToMode(h, s) {
    // Desaturated → pentatonic (mode-ambiguous)
    if (s < 0.15) return 'pentatonic';

    if (h < 20)  return 'lydian';
    if (h < 50)  return 'mixolydian';
    if (h < 80)  return 'major';
    if (h < 160) return 'dorian';
    if (h < 200) return 'mixolydian';
    if (h < 260) return 'minor';
    if (h < 310) return 'phrygian';
    return 'lydian';
  }

  /* ── Hue → root note (pitch class) ───────────────────── */
  /*  Map the color wheel to a chromatic circle of fifths feel.
   *  Warm colors cluster around C/G/D; cool around F#/B/E.
   */
  function hueToRoot(h) {
    const roots = ['C','G','D','A','E','B','F#','C#','G#','D#','A#','F'];
    const idx = Math.floor((h / 360) * 12) % 12;
    return roots[idx];
  }

  /* ── Lightness → base octave ─────────────────────────── */
  function lightnessToOctave(l) {
    if (l < 0.25) return 3;
    if (l < 0.55) return 4;
    return 5;
  }

  /* ── Warmth → BPM nudge ──────────────────────────────── */
  function warmthToBpm(r, g, b) {
    const warmth = (r - b) / 255; // -1 (cool) → +1 (warm)
    return Math.round(68 + warmth * 8);
  }

  /* ── Scalar image metrics (drive the generative synth) ── */
  /*
   * A single extra pass over a sampled grid giving us:
   *   brightness       — mean lightness            (0..1, dark → light)
   *   contrast         — spread of lightness       (0..1, hazy → dramatic)
   *   saturationSpread — spread of saturation      (0..1, muted → vivid variety)
   *
   * These feed the Weather-Station mapping on the AM synth layer — so a
   * misty monochrome lake gets sparse low pads, and a sharp sunset city
   * gets frequent airy detuned tones in the upper register.
   */
  function _extractImageMetrics(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    const stepX = Math.max(1, Math.floor(w / 80));
    const stepY = Math.max(1, Math.floor(h / 80));
    let sumL = 0, sumL2 = 0, sumS = 0, sumS2 = 0, n = 0;
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const i = (y * w + x) * 4;
        const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        sumL += hsl.l; sumL2 += hsl.l * hsl.l;
        sumS += hsl.s; sumS2 += hsl.s * hsl.s;
        n++;
      }
    }
    if (n === 0) return { brightness: 0.5, contrast: 0.3, saturationSpread: 0.3 };
    const meanL = sumL / n;
    const varL = Math.max(0, sumL2 / n - meanL * meanL);
    const meanS = sumS / n;
    const varS = Math.max(0, sumS2 / n - meanS * meanS);
    // std-dev scaled so a typical photograph hits roughly mid-range
    return {
      brightness: meanL,
      contrast: Math.min(1, Math.sqrt(varL) * 3.2),
      saturationSpread: Math.min(1, Math.sqrt(varS) * 3.2),
    };
  }

  /* ── Main: derive all musical params from an image ──── */

  function analyze(canvas) {
    const palette = extractPalette(canvas, 5);
    const metrics = _extractImageMetrics(canvas);
    if (palette.length === 0) {
      return {
        palette: [],
        dominant: { r: 120, g: 120, b: 130, h: 0, s: 0, l: 0.5 },
        mode: 'pentatonic',
        root: 'C',
        octave: 4,
        bpm: 68,
        accentSaturation: 0,
        accentWarmth: 0,
        ...metrics,
      };
    }

    // Dominant color for tonal analysis comes from the RAW top-3 by
    // frequency — this is about "what colors dominate the pixels,"
    // independent of the display palette (which injects vibrance accents).
    const dominants = extractDominants(canvas, 3);
    const totalW = dominants.reduce((a, c) => a + c.weight, 0) || 1;
    const avgR = dominants.reduce((a, c) => a + c.r * c.weight, 0) / totalW;
    const avgG = dominants.reduce((a, c) => a + c.g * c.weight, 0) / totalW;
    const avgB = dominants.reduce((a, c) => a + c.b * c.weight, 0) / totalW;

    const hsl = rgbToHsl(avgR, avgG, avgB);
    const mode   = hueToMode(hsl.h, hsl.s);
    const root   = hueToRoot(hsl.h);
    const octave = lightnessToOctave(hsl.l);
    const bpm    = warmthToBpm(avgR, avgG, avgB);

    // Accent metrics: mean saturation of the TWO most colorful swatches.
    // These drive how "present" the strings layer feels — a vivid image
    // with strong accents gets a lusher, wetter string bed.
    const colorful = [...palette]
      .filter(c => c.s > 0.2)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2);
    const accentSaturation = colorful.length
      ? colorful.reduce((a, c) => a + c.s, 0) / colorful.length
      : 0;
    const accentWarmth = colorful.length
      ? colorful.reduce((a, c) => a + (c.r - c.b) / 255, 0) / colorful.length
      : 0;

    return {
      palette,
      dominant: { r: avgR, g: avgG, b: avgB, ...hsl },
      mode,
      root,
      octave,
      bpm,
      accentSaturation, // 0..1
      accentWarmth,     // -1..1
      ...metrics,       // brightness, contrast, saturationSpread
    };
  }

  return { analyze, extractPalette, rgbToHsl };
})();
