/**
 * Silhouette extraction and spectrogram data computation.
 *
 * extract()           — dispatcher; picks v1 (sky-region-growing) or v2
 *                       (Sobel gradient + continuity-constrained top-edge)
 *                       based on window.__skylineDetectMode ('v1' | 'v2').
 * extractV1()         — legacy sky-region-growing
 * extractV2()         — improved: pre-blur → Sobel → per-column top-most
 *                       strong edge with continuity constraint
 * computeSpectrogram() — turn a height profile into a 2-D energy grid
 * downsample()        — reduce a profile to N points
 */

const SilhouetteExtractor = (() => {

  /* ── Dispatcher ─────────────────────────────────────────── */

  function extract(canvas) {
    const mode = (typeof window !== 'undefined' && window.__skylineDetectMode) || 'v3';
    if (mode === 'v1') return extractV1(canvas);
    if (mode === 'v2') return extractV2(canvas);
    return extractV3(canvas);
  }

  /* ── V1: legacy sky-region-growing (kept for A/B toggle) ── */

  function extractV1(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;

    // Grayscale
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }

    // Pre-blur to remove stars, windows, and small detail
    const blurred = boxBlur(gray, w, h, 7);

    const profile = new Float32Array(w);
    const startRow = Math.floor(h * 0.03);
    const endRow = Math.floor(h * 0.95);

    for (let x = 0; x < w; x++) {
      // Sky-region growing: start at top, grow down.
      // Sky gradients change slowly; foreground edges are abrupt.
      let skyAvg = blurred[x];
      let horizonY = 0;
      let breakRun = 0;

      for (let y = 1; y < endRow; y++) {
        const br = blurred[y * w + x];
        const prev = blurred[(y - 1) * w + x];

        const stepDelta = Math.abs(br - prev);
        const avgDelta  = Math.abs(br - skyAvg);

        // Adaptive thresholds — tighter for dark skies
        const stepTh = Math.max(2.5, skyAvg * 0.05 + 1.8);
        const avgTh  = Math.max(10, skyAvg * 0.22 + 4);

        if (stepDelta < stepTh && avgDelta < avgTh) {
          skyAvg = skyAvg * 0.93 + br * 0.07;
          horizonY = y;
          breakRun = 0;
        } else {
          breakRun++;
          if (breakRun >= 6) { horizonY = y - 5; break; }
        }
      }

      profile[x] = 1 - horizonY / h;
    }

    // Remove outlier dips: if a column is much lower than its neighbours,
    // pull it up to the local minimum of the surrounding region.
    const cleaned = removeOutlierDips(profile, w);

    return smooth(cleaned, 10);
  }

  /* ── V2: Sobel gradient + continuity-constrained top edge ── */

  function extractV2(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;

    // Grayscale
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }

    // Lighter blur than v1 — we want edges preserved, not smeared
    const blurred = boxBlur(gray, w, h, 3);

    // Sobel gradient magnitude
    //   Gx = [-1 0 1; -2 0 2; -1 0 1]
    //   Gy = [-1 -2 -1; 0 0 0; 1 2 1]
    const mag = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const tl = blurred[(y - 1) * w + (x - 1)];
        const t  = blurred[(y - 1) * w + x];
        const tr = blurred[(y - 1) * w + (x + 1)];
        const l  = blurred[y * w + (x - 1)];
        const r  = blurred[y * w + (x + 1)];
        const bl = blurred[(y + 1) * w + (x - 1)];
        const b  = blurred[(y + 1) * w + x];
        const br = blurred[(y + 1) * w + (x + 1)];

        const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }

    // Adaptive threshold — top Nth-percentile of gradient magnitudes.
    // We only keep "strong" edges, not noisy ridges of clouds or textures.
    const magThreshold = percentile(mag, 0.82); // keep top 18%

    // Also factor in vertical brightness-delta from the top — a sky-vs-ground
    // transition is characterised by going from bright to dim (usually) or
    // from even to textured. We gate on both gradient strength AND a
    // noticeable brightness change from the initial sky sample.
    const startRow = Math.floor(h * 0.02);
    const endRow = Math.floor(h * 0.96);

    // Row where we "begin" scanning — above this, sample the sky
    const skySample = Math.max(0, startRow);

    // First pass: per-column top-most strong edge (no continuity yet)
    const raw = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      // Running sky brightness for this column's upper region
      let skyAvg = 0, skyN = 0;
      for (let y = skySample; y < Math.min(skySample + 10, h); y++) {
        skyAvg += blurred[y * w + x]; skyN++;
      }
      skyAvg /= Math.max(1, skyN);

      let horizonY = endRow - 1; // default: all the way down if no edge
      for (let y = startRow + 1; y < endRow; y++) {
        const m = mag[y * w + x];
        const b = blurred[y * w + x];
        const brightDelta = Math.abs(b - skyAvg);

        // Gate: strong gradient AND meaningful brightness departure from sky
        const brightGate = Math.max(8, skyAvg * 0.18);
        if (m >= magThreshold && brightDelta >= brightGate) {
          horizonY = y;
          break;
        }

        // Drift the sky average slowly so gradual gradients don't false-trip
        if (m < magThreshold * 0.4 && brightDelta < brightGate * 0.6) {
          skyAvg = skyAvg * 0.95 + b * 0.05;
        }
      }
      raw[x] = horizonY;
    }

    // Second pass: continuity constraint.
    // Reject any jump > maxJumpPx vs. a robust local baseline (median filter)
    // unless the gradient at that position is exceptionally strong
    // (a real steep ridge, not cloud noise).
    const maxJumpPx = Math.max(12, h * 0.05);
    const strongMagThreshold = percentile(mag, 0.95); // top 5% — undeniable edges
    const medianRadius = 24;
    const baseline = medianFilter(raw, medianRadius);

    const constrained = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const y = raw[x];
      const base = baseline[x];
      const dy = y - base;
      if (Math.abs(dy) <= maxJumpPx) {
        constrained[x] = y;
      } else {
        // Allow override if gradient here is exceptionally strong
        const yInt = Math.max(1, Math.min(h - 2, Math.floor(y)));
        if (mag[yInt * w + x] >= strongMagThreshold) {
          constrained[x] = y;
        } else {
          // Snap to local baseline
          constrained[x] = base;
        }
      }
    }

    // Convert pixel Y → normalised 0..1 height (1 = top of image)
    const profile = new Float32Array(w);
    for (let x = 0; x < w; x++) profile[x] = 1 - constrained[x] / h;

    // Light outlier dip removal (v2 should produce fewer dips, so lower
    // threshold and fewer passes than v1)
    const cleaned = removeOutlierDips(profile, w, /* radius */ 30,
                                      /* dipThreshold */ 0.06,
                                      /* passes */ 2);

    // Final smoothing — less aggressive than v1 to keep ridge detail
    return smooth(cleaned, 6);
  }

  /* ── V3: DP shortest-path (seam-style) horizon finder ──────
   *
   *  Frame the horizon as the minimum-cost path from the left edge to
   *  the right edge of a cost image, where cost is low where the image
   *  gradient is strong.  A small additive "upper bias" gently pulls the
   *  path toward the top when two edges are equally strong (e.g., mountain
   *  vs. reflection in a lake).
   *
   *  The path can only step ±maxDy rows between adjacent columns, so
   *  continuity is guaranteed by construction — no outlier-dip cleanup
   *  needed.  This is the same DP as seam-carving.
   *
   *  Complexity: O(w · h · (2·maxDy + 1)).  For a 938×348 image with
   *  maxDy=2 this runs in ≈5 ms.
   */
  function extractV3(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;

    // Grayscale
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }

    // Light blur — preserve edges, kill single-pixel noise
    const blurred = boxBlur(gray, w, h, 2);

    // Sobel gradient magnitude
    const mag = new Float32Array(w * h);
    let maxMag = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const tl = blurred[(y - 1) * w + (x - 1)];
        const t  = blurred[(y - 1) * w + x];
        const tr = blurred[(y - 1) * w + (x + 1)];
        const l  = blurred[y * w + (x - 1)];
        const r  = blurred[y * w + (x + 1)];
        const bl = blurred[(y + 1) * w + (x - 1)];
        const b  = blurred[(y + 1) * w + x];
        const br = blurred[(y + 1) * w + (x + 1)];

        const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        const m = Math.sqrt(gx * gx + gy * gy);
        mag[y * w + x] = m;
        if (m > maxMag) maxMag = m;
      }
    }
    const invMag = 1 / Math.max(1e-6, maxMag);

    // Search band — exclude top few rows (title bars, sky artefacts) and
    // bottom rows (guaranteed ground).
    const topBand = Math.floor(h * 0.02);
    const botBand = Math.floor(h * 0.96);
    const bandH   = botBand - topBand;

    // Per-column prefix sum of gradient magnitude — lets us cheaply ask
    // "how much gradient energy is above row y in column x?"  A pixel that
    // has a lot of gradient above it is *below* some earlier edge and is
    // unlikely to be the true horizon (prevents the DP from settling on a
    // smooth secondary ridge — e.g., the distant mountain behind tall
    // buildings).
    const gradAbove = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = 0; y < h; y++) {
        gradAbove[y * w + x] = s;
        s += mag[y * w + x];
      }
    }
    // Column totals for normalisation
    const colTotal = new Float32Array(w);
    for (let x = 0; x < w; x++) colTotal[x] = Math.max(1e-6, gradAbove[(h - 1) * w + x] + mag[(h - 1) * w + x]);

    // Estimate "sky-ness" from the top strip: average brightness over the
    // top few rows.  A pixel is flagged as sky if its brightness is near
    // the sky sample AND its gradient is weak.
    let skyAvg = 0, skyN = 0;
    for (let y = 0; y < topBand + 5; y++) {
      for (let x = 0; x < w; x++) {
        skyAvg += blurred[y * w + x];
        skyN++;
      }
    }
    skyAvg /= Math.max(1, skyN);

    // Cost weights
    const alpha        = 0.08;   // mild top-bias
    const beta         = 0.55;   // penalty for gradient already seen above
    const skyPenalty   = 0.15;   // penalty for cells inside obvious sky

    const cost = new Float32Array(w * bandH);
    for (let y = 0; y < bandH; y++) {
      const absY = y + topBand;
      for (let x = 0; x < w; x++) {
        const g = mag[absY * w + x];
        const b = blurred[absY * w + x];
        const isSky = Math.abs(b - skyAvg) < Math.max(10, skyAvg * 0.12)
                      && (g * invMag) < 0.15;
        // Fraction of this column's gradient energy that lies above (x, y).
        // Range 0..1; small for topmost edges, ≈1 for bottom rows.
        const aboveFrac = gradAbove[absY * w + x] / colTotal[x];
        cost[y * w + x] = (1 - g * invMag)
                        + alpha * (absY / h)
                        + beta  * aboveFrac
                        + (isSky ? skyPenalty : 0);
      }
    }

    // DP forward pass.  dp[y*w + x] = min total cost to reach (x, y).
    // back[y*w + x] stores the y-offset used from the previous column
    // (so backtracking is O(w)).
    const maxDy = 2;
    const dp   = new Float32Array(w * bandH);
    const back = new Int8Array(w * bandH);

    // First column bootstraps with just the cost
    for (let y = 0; y < bandH; y++) {
      dp[y * w + 0] = cost[y * w + 0];
    }

    for (let x = 1; x < w; x++) {
      for (let y = 0; y < bandH; y++) {
        let best = Infinity, bestOff = 0;
        for (let dy = -maxDy; dy <= maxDy; dy++) {
          const py = y + dy;
          if (py < 0 || py >= bandH) continue;
          const v = dp[py * w + (x - 1)];
          if (v < best) { best = v; bestOff = dy; }
        }
        dp[y * w + x]   = cost[y * w + x] + best;
        back[y * w + x] = bestOff;
      }
    }

    // Backtrack: find the min-cost cell in the last column
    let minY = 0, minVal = Infinity;
    for (let y = 0; y < bandH; y++) {
      const v = dp[y * w + (w - 1)];
      if (v < minVal) { minVal = v; minY = y; }
    }

    const horizonY = new Float32Array(w);
    horizonY[w - 1] = minY + topBand;
    let cy = minY;
    for (let x = w - 1; x > 0; x--) {
      const off = back[cy * w + x];
      cy = cy + off;
      horizonY[x - 1] = cy + topBand;
    }

    // Convert pixel Y → normalised 0..1 height (1 = top of image)
    const profile = new Float32Array(w);
    for (let x = 0; x < w; x++) profile[x] = 1 - horizonY[x] / h;

    // Light smoothing to remove the 1-pixel staircase from the DP path.
    // No outlier-dip removal needed — continuity is guaranteed by the DP.
    return smooth(profile, 3);
  }

  /* ── Helpers for V2 ───────────────────────────────────────── */

  // Percentile by random sampling (avoids sort of huge array)
  function percentile(arr, p) {
    const n = Math.min(arr.length, 5000);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = arr[Math.floor(Math.random() * arr.length)];
    }
    const sorted = Array.from(samples).sort((a, b) => a - b);
    return sorted[Math.floor(p * (sorted.length - 1))];
  }

  // 1-D median filter with given radius
  function medianFilter(arr, radius) {
    const out = new Float32Array(arr.length);
    const buf = [];
    for (let i = 0; i < arr.length; i++) {
      buf.length = 0;
      const lo = Math.max(0, i - radius);
      const hi = Math.min(arr.length - 1, i + radius);
      for (let j = lo; j <= hi; j++) buf.push(arr[j]);
      buf.sort((a, b) => a - b);
      out[i] = buf[Math.floor(buf.length / 2)];
    }
    return out;
  }

  /* ── Outlier dip removal ─────────────────────────────────── */

  function removeOutlierDips(profile, len, radius = 40, dipThreshold = 0.04, passes = 3) {
    const out = new Float32Array(profile);

    for (let pass = 0; pass < passes; pass++) {
      const src = new Float32Array(out);
      for (let i = 0; i < len; i++) {
        let leftAvg = 0, leftN = 0;
        let rightAvg = 0, rightN = 0;

        for (let j = Math.max(0, i - radius); j < i; j++) {
          leftAvg += src[j]; leftN++;
        }
        for (let j = i + 1; j <= Math.min(len - 1, i + radius); j++) {
          rightAvg += src[j]; rightN++;
        }

        if (leftN > 0) leftAvg /= leftN;
        if (rightN > 0) rightAvg /= rightN;

        const neighbourAvg = (leftN > 0 && rightN > 0)
          ? (leftAvg + rightAvg) / 2
          : (leftN > 0 ? leftAvg : rightAvg);

        // If this column dips more than dipThreshold below its neighbours, pull it up
        if (src[i] < neighbourAvg - dipThreshold) {
          out[i] = neighbourAvg - 0.01;
        }
      }
    }
    return out;
  }

  /* ── Box blur (separable, two-pass) ────────────────────── */

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);

    // Horizontal
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < w) { s += src[y * w + nx]; c++; }
        }
        tmp[y * w + x] = s / c;
      }
    }
    // Vertical
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let dy = -r; dy <= r; dy++) {
          const ny = y + dy;
          if (ny >= 0 && ny < h) { s += tmp[ny * w + x]; c++; }
        }
        out[y * w + x] = s / c;
      }
    }
    return out;
  }

  /* ── Profile smoothing (weighted multi-pass) ───────────── */

  function smooth(profile, passes) {
    let cur = new Float32Array(profile);
    const half = 10;
    for (let p = 0; p < passes; p++) {
      const nxt = new Float32Array(cur.length);
      for (let i = 0; i < cur.length; i++) {
        let s = 0, wt = 0;
        for (let j = -half; j <= half; j++) {
          const idx = i + j;
          if (idx >= 0 && idx < cur.length) {
            const w = 1 - Math.abs(j) / (half + 1);
            s += cur[idx] * w;
            wt += w;
          }
        }
        nxt[i] = s / wt;
      }
      cur = nxt;
    }
    return cur;
  }

  /* ── Downsample ────────────────────────────────────────── */

  function downsample(profile, count) {
    const out = new Float32Array(count);
    const seg = profile.length / count;
    for (let i = 0; i < count; i++) {
      const a = Math.floor(i * seg), b = Math.floor((i + 1) * seg);
      let s = 0;
      for (let j = a; j < b; j++) s += profile[j];
      out[i] = s / (b - a);
    }
    return out;
  }

  return { extract, downsample, smooth };
})();
