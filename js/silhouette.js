/**
 * Silhouette extraction and spectrogram data computation.
 *
 * extract()           — sky-region-growing to find the horizon edge
 * computeSpectrogram() — turn a height profile into a 2-D energy grid
 * downsample()        — reduce a profile to N points
 */

const SilhouetteExtractor = (() => {

  /* ── Height profile extraction ─────────────────────────── */

  function extract(canvas) {
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

  /* ── Outlier dip removal ─────────────────────────────────── */

  function removeOutlierDips(profile, len) {
    const out = new Float32Array(profile);
    const radius = 40;

    for (let pass = 0; pass < 3; pass++) {
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

        // If this column dips more than 4% below its neighbours, pull it up
        if (src[i] < neighbourAvg - 0.04) {
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
