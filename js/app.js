/**
 * Main application — mirrored spectrogram with scientific overlay.
 *
 * The canvas shows a landscape photo on the left that fades out at
 * the midpoint. A vertically-mirrored granular spectrogram spans
 * the full width, becoming more visible as the photo fades. The
 * right half's background color is tinted by the photo's dominant
 * colour. A coordinate grid, silhouette curve, and equation labels
 * overlay the entire composition.
 *
 * Layers (bottom → top):
 *   1. Photo-tinted background (right half)
 *   2. Landscape photograph (fades out at midpoint)
 *   3. Mirrored granular spectrogram (full width)
 *   4. Coordinate grid
 *   5. Silhouette function curve
 *   6. Equation labels
 *   7. Playhead
 */

class SkylineSoundApp {
  constructor() {
    this.imageCanvas   = document.getElementById('imageCanvas');
    this.overlayCanvas = document.getElementById('overlayCanvas');
    this.container     = document.getElementById('canvasContainer');

    this.W = 1200;
    this.H = 675;
    this.imageCanvas.width  = this.W;
    this.imageCanvas.height = this.H;
    this.overlayCanvas.width  = this.W;
    this.overlayCanvas.height = this.H;

    // Offscreen canvases
    this.specCanvas = document.createElement('canvas');
    this.specCanvas.width  = this.W;
    this.specCanvas.height = this.H;

    this.compCanvas = document.createElement('canvas');
    this.compCanvas.width  = this.W;
    this.compCanvas.height = this.H;

    // Spectrogram parameters
    this.numCols    = 200;
    this.numBands   = 48;
    this.barProfile = null;
    this.barGlow    = new Float32Array(this.numCols).fill(0);

    // Dominant colour from photo
    this.dominantR = 120;
    this.dominantG = 120;
    this.dominantB = 130;

    // Grid margins
    this.margin = { left: 48, right: 24, top: 24, bottom: 40 };

    // State
    this.heightProfile  = null;
    this.currentPlayIdx = -1;
    this.engine = new MusicEngine();
    this.animId = null;

    this._bind();
    this._loadSample('city');
    this._animate();
  }

  /* ────────────────────────────────────────────────────── */
  /*  Event binding                                        */
  /* ────────────────────────────────────────────────────── */

  _bind() {
    // Scene nav
    document.querySelectorAll('.scene-nav .nav-btn[data-sample]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._activate('.scene-nav .nav-btn', btn);
        this._loadSample(btn.dataset.sample);
      });
    });

    // Upload
    const fileInput = document.getElementById('fileInput');
    document.getElementById('uploadBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      if (e.target.files.length) {
        this._loadUpload(e.target.files[0]);
        this._activate('.scene-nav .nav-btn', document.getElementById('uploadBtn'));
      }
    });

    // Instruments
    document.querySelectorAll('.inst-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._activate('.inst-btn', btn);
        this.engine.setInstrument(btn.dataset.instrument);
      });
    });

    // Play / Pause toggle
    document.getElementById('playToggle').addEventListener('click', () => {
      if (this.engine.isPlaying) this._pause();
      else this._play();
    });

    // Volume slider
    const vol = document.getElementById('volumeSlider');
    const volV = document.getElementById('volumeValue');
    if (vol) {
      vol.addEventListener('input', () => {
        volV.textContent = vol.value;
        this.engine.setVolume(+vol.value / 100);
      });
    }

    // Tempo slider
    const tempo = document.getElementById('tempoSlider');
    const tempoV = document.getElementById('tempoValue');
    tempo.addEventListener('input', () => {
      tempoV.textContent = tempo.value;
      this.engine.setBpm(+tempo.value);
    });

    // Density slider
    const dens = document.getElementById('densitySlider');
    const densV = document.getElementById('densityValue');
    dens.addEventListener('input', () => {
      densV.textContent = dens.value;
      this.engine.setNoteCount(+dens.value);
      if (this.heightProfile) {
        this.engine.setHeightProfile(this.heightProfile);
        this.barProfile = SilhouetteExtractor.downsample(this.heightProfile, this.numCols);
        this._preRenderSpectrogram();
      }
    });

    // Scale
    document.getElementById('scaleSelect').addEventListener('change', e => {
      this.engine.setScale(e.target.value);
    });

    // Audio → visual callback
    this.engine.onNotePlay = idx => {
      this.currentPlayIdx = idx;
      const s = Math.floor(idx / this.engine.noteCount * this.numCols);
      const e = Math.floor((idx + 1) / this.engine.noteCount * this.numCols);
      for (let b = s; b <= e && b < this.numCols; b++) {
        this.barGlow[b] = 1.0;
      }
    };
  }

  _activate(selector, el) {
    document.querySelectorAll(selector).forEach(b => b.classList.remove('active'));
    el.classList.add('active');
  }

  /* ────────────────────────────────────────────────────── */
  /*  Image loading                                        */
  /* ────────────────────────────────────────────────────── */

  async _loadSample(type) {
    this._stop();
    await SampleGenerator.generate(this.imageCanvas, type);
    this._process();
  }

  _loadUpload(file) {
    this._stop();
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const ctx = this.imageCanvas.getContext('2d');
        ctx.clearRect(0, 0, this.W, this.H);
        const s = Math.max(this.W / img.width, this.H / img.height);
        const sw = img.width * s, sh = img.height * s;
        ctx.drawImage(img, (this.W - sw) / 2, (this.H - sh) / 2, sw, sh);
        this._process();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  _process() {
    this.heightProfile = SilhouetteExtractor.extract(this.imageCanvas);
    this.engine.setHeightProfile(this.heightProfile);
    this.barProfile = SilhouetteExtractor.downsample(this.heightProfile, this.numCols);
    this.barGlow = new Float32Array(this.numCols).fill(0);
    this.currentPlayIdx = -1;
    this._extractDominantColor();
    this._preRenderSpectrogram();
  }

  /* ────────────────────────────────────────────────────── */
  /*  Dominant color extraction                            */
  /* ────────────────────────────────────────────────────── */

  _extractDominantColor() {
    const ctx = this.imageCanvas.getContext('2d');
    const data = ctx.getImageData(0, 0, this.W, this.H).data;
    const stepX = Math.floor(this.W / 30);
    const stepY = Math.floor(this.H / 30);
    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    for (let y = 0; y < this.H; y += stepY) {
      for (let x = 0; x < this.W; x += stepX) {
        const idx = (y * this.W + x) * 4;
        rSum += data[idx];
        gSum += data[idx + 1];
        bSum += data[idx + 2];
        count++;
      }
    }

    this.dominantR = Math.round(rSum / count);
    this.dominantG = Math.round(gSum / count);
    this.dominantB = Math.round(bSum / count);
  }

  /* ────────────────────────────────────────────────────── */
  /*  Pre-render mirrored spectrogram                      */
  /* ────────────────────────────────────────────────────── */

  _preRenderSpectrogram() {
    if (!this.barProfile) return;

    const ctx = this.specCanvas.getContext('2d');
    const W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);

    const midY  = H / 2;
    const cols  = this.numCols;
    const bands = this.numBands;
    const colW  = W / cols;
    const bandH = midY / bands;

    const dR = this.dominantR, dG = this.dominantG, dB = this.dominantB;

    for (let c = 0; c < cols; c++) {
      const x = c * colW;
      const h = this.barProfile[c];
      const t = c / cols; // 0→1 left to right

      for (let b = 0; b < bands; b++) {
        const bandPos = b / bands; // 0 = center, 1 = edge
        const dist = bandPos;

        // Energy: Gaussian centered at 0, spread proportional to height
        const sigma = Math.max(0.08, h * 0.7);
        const energy = Math.exp(-(dist * dist) / (2 * sigma * sigma));

        // Add harmonic at ~0.5 distance
        const hDist = Math.abs(dist - 0.45);
        const harmonic = 0.2 * Math.exp(-(hDist * hDist) / (2 * 0.06 * 0.06)) * h;

        let e = Math.min(1, energy + harmonic);

        // Granular noise
        e *= 0.85 + Math.random() * 0.15;

        if (e < 0.02) continue;

        // Color: amber on left, photo-tinted on right
        const leftR = 160, leftG = 120, leftB = 70;
        const rightR = Math.min(255, dR * 0.7 + 60);
        const rightG = Math.min(255, dG * 0.7 + 50);
        const rightB = Math.min(255, dB * 0.7 + 40);

        const r = Math.round(leftR + (rightR - leftR) * t);
        const g = Math.round(leftG + (rightG - leftG) * t);
        const bv = Math.round(leftB + (rightB - leftB) * t);

        const alpha = e * (0.35 + t * 0.45);

        ctx.fillStyle = `rgba(${r},${g},${bv},${alpha})`;

        // Top half (upward from center)
        const yTop = midY - (b + 1) * bandH;
        ctx.fillRect(x, yTop, colW - 0.5, bandH);

        // Bottom half (mirror downward)
        const yBot = midY + b * bandH;
        ctx.fillRect(x, yBot, colW - 0.5, bandH);
      }
    }
  }

  /* ────────────────────────────────────────────────────── */
  /*  Render loop                                          */
  /* ────────────────────────────────────────────────────── */

  _animate() {
    const loop = () => {
      this.animId = requestAnimationFrame(loop);
      this._drawFrame();
    };
    loop();
  }

  _drawFrame() {
    const ctx = this.overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, this.W, this.H);
    if (!this.barProfile) return;

    // Decay glow
    for (let i = 0; i < this.numCols; i++) {
      this.barGlow[i] = Math.max(0, this.barGlow[i] * 0.955);
    }

    // Layer 1: Right-half tinted background
    this._drawTintedBackground(ctx);

    // Layer 2: Photo with fade-out at midpoint
    this._drawPhotoFade(ctx);

    // Layer 3: Mirrored spectrogram (pre-rendered + glow overlay)
    this._drawSpectrogram(ctx);

    // Layer 4: Grid
    this._drawGrid(ctx);

    // Layer 5: Silhouette curve
    this._drawSilhouetteCurve(ctx);

    // Layer 6: Equation labels
    this._drawEquationLabel(ctx);

    // Layer 7: Playhead
    this._drawPlayhead(ctx);
  }

  /* ── Layer 1: Tinted background on right half ────────── */

  _drawTintedBackground(ctx) {
    const dR = this.dominantR, dG = this.dominantG, dB = this.dominantB;
    // Muted, lighter version of the dominant color
    const r = Math.min(255, Math.round(dR * 0.25 + 200));
    const g = Math.min(255, Math.round(dG * 0.25 + 200));
    const b = Math.min(255, Math.round(dB * 0.25 + 200));

    const grad = ctx.createLinearGradient(this.W * 0.4, 0, this.W * 0.65, 0);
    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},1)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.W, this.H);
  }

  /* ── Layer 2: Photo fade ─────────────────────────────── */

  _drawPhotoFade(ctx) {
    const cCtx = this.compCanvas.getContext('2d');
    cCtx.clearRect(0, 0, this.W, this.H);
    cCtx.drawImage(this.imageCanvas, 0, 0);

    // Fade out from ~35% to ~65%
    cCtx.globalCompositeOperation = 'destination-in';
    const mask = cCtx.createLinearGradient(this.W * 0.3, 0, this.W * 0.7, 0);
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    cCtx.fillStyle = mask;
    cCtx.fillRect(0, 0, this.W, this.H);
    cCtx.globalCompositeOperation = 'source-over';

    ctx.drawImage(this.compCanvas, 0, 0);
  }

  /* ── Layer 3: Spectrogram with glow ──────────────────── */

  _drawSpectrogram(ctx) {
    // Draw the pre-rendered spectrogram
    ctx.drawImage(this.specCanvas, 0, 0);

    // Draw per-column glow overlay for active notes
    const colW = this.W / this.numCols;
    const midY = this.H / 2;
    const bandH = midY / this.numBands;

    for (let c = 0; c < this.numCols; c++) {
      const glow = this.barGlow[c];
      if (glow < 0.03) continue;

      const x = c * colW;
      const h = this.barProfile[c];
      const t = c / this.numCols;
      const maxBands = Math.ceil(h * this.numBands);

      // Glow color
      const dR = this.dominantR, dG = this.dominantG, dB = this.dominantB;
      const r = Math.round(180 + (dR * 0.3) * t);
      const g = Math.round(150 + (dG * 0.3) * t);
      const b = Math.round(100 + (dB * 0.3) * t);

      for (let band = 0; band < maxBands && band < this.numBands; band++) {
        const bandFade = 1 - (band / maxBands) * 0.7;
        const alpha = glow * 0.35 * bandFade;

        ctx.fillStyle = `rgba(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)},${alpha})`;

        // Top
        ctx.fillRect(x, midY - (band + 1) * bandH, colW - 0.5, bandH);
        // Bottom (mirror)
        ctx.fillRect(x, midY + band * bandH, colW - 0.5, bandH);
      }
    }
  }

  /* ── Layer 4: Grid ───────────────────────────────────── */

  _drawGrid(ctx) {
    const m = this.margin;
    const plotW = this.W - m.left - m.right;
    const plotH = this.H - m.top - m.bottom;

    ctx.save();
    const numV = 12, numH = 8;

    // Grid lines — visible
    ctx.strokeStyle = 'rgba(80, 80, 80, 0.18)';
    ctx.lineWidth = 0.5;

    for (let i = 0; i <= numV; i++) {
      const x = m.left + (plotW / numV) * i;
      ctx.beginPath();
      ctx.moveTo(x, m.top);
      ctx.lineTo(x, this.H - m.bottom);
      ctx.stroke();
    }

    for (let i = 0; i <= numH; i++) {
      const y = m.top + (plotH / numH) * i;
      ctx.beginPath();
      ctx.moveTo(m.left, y);
      ctx.lineTo(this.W - m.right, y);
      ctx.stroke();
    }

    // Center line (mirror axis) — stronger
    ctx.strokeStyle = 'rgba(80, 80, 80, 0.25)';
    ctx.lineWidth = 0.75;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(m.left, this.H / 2);
    ctx.lineTo(this.W - m.right, this.H / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Axes
    ctx.strokeStyle = 'rgba(50, 50, 50, 0.35)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(m.left, this.H - m.bottom);
    ctx.lineTo(this.W - m.right, this.H - m.bottom);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(m.left, m.top);
    ctx.lineTo(m.left, this.H - m.bottom);
    ctx.stroke();

    // Tick labels
    ctx.fillStyle = 'rgba(50, 50, 50, 0.45)';
    ctx.font = '10px "STIX Two Text", serif';

    ctx.textAlign = 'center';
    for (let i = 0; i <= numV; i += 2) {
      const x = m.left + (plotW / numV) * i;
      const val = (i / numV).toFixed(1);
      ctx.beginPath();
      ctx.moveTo(x, this.H - m.bottom);
      ctx.lineTo(x, this.H - m.bottom + 4);
      ctx.stroke();
      ctx.fillText(val, x, this.H - m.bottom + 15);
    }

    ctx.textAlign = 'right';
    for (let i = 0; i <= numH; i += 2) {
      const y = m.top + (plotH / numH) * i;
      const val = (1 - i / numH).toFixed(1);
      ctx.beginPath();
      ctx.moveTo(m.left - 4, y);
      ctx.lineTo(m.left, y);
      ctx.stroke();
      ctx.fillText(val, m.left - 7, y + 3);
    }

    // Axis labels
    ctx.fillStyle = 'rgba(50, 50, 50, 0.40)';
    ctx.font = 'italic 11px "STIX Two Text", serif';
    ctx.textAlign = 'center';
    ctx.fillText('x', this.W / 2, this.H - 6);

    ctx.save();
    ctx.translate(13, this.H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('h(x)', 0, 0);
    ctx.restore();

    ctx.restore();
  }

  /* ── Layer 5: Silhouette curve ───────────────────────── */

  _drawSilhouetteCurve(ctx) {
    if (!this.heightProfile) return;

    const m = this.margin;
    const plotW = this.W - m.left - m.right;
    const plotH = this.H - m.top - m.bottom;
    const step = Math.max(1, Math.floor(this.heightProfile.length / 600));

    ctx.save();
    ctx.strokeStyle = 'rgba(40, 40, 40, 0.55)';
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    for (let i = 0; i < this.heightProfile.length; i += step) {
      const x = m.left + (i / (this.heightProfile.length - 1)) * plotW;
      const y = m.top + (1 - this.heightProfile[i]) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ── Layer 6: Equation labels ────────────────────────── */

  _drawEquationLabel(ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(50, 50, 50, 0.45)';
    ctx.font = 'italic 13px "STIX Two Text", serif';
    ctx.textAlign = 'right';
    ctx.fillText('h(x) = silhouette(x)', this.W - 36, 46);

    if (this.heightProfile) {
      let sum = 0;
      for (let i = 0; i < this.heightProfile.length; i++) sum += this.heightProfile[i];
      const mean = (sum / this.heightProfile.length).toFixed(3);
      ctx.font = '11px "STIX Two Text", serif';
      ctx.fillText('\u03BC = ' + mean, this.W - 36, 64);

      // Range annotation
      let mn = 1, mx = 0;
      for (let i = 0; i < this.heightProfile.length; i++) {
        if (this.heightProfile[i] < mn) mn = this.heightProfile[i];
        if (this.heightProfile[i] > mx) mx = this.heightProfile[i];
      }
      ctx.fillText('range = [' + mn.toFixed(2) + ', ' + mx.toFixed(2) + ']', this.W - 36, 80);
    }
    ctx.restore();
  }

  /* ── Layer 7: Playhead ───────────────────────────────── */

  _drawPlayhead(ctx) {
    if (!this.engine.isPlaying || this.currentPlayIdx < 0) return;

    const progress = (this.currentPlayIdx + 0.5) / this.engine.noteCount;
    const px = progress * this.W;

    ctx.strokeStyle = 'rgba(50, 50, 50, 0.20)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, this.H);
    ctx.stroke();
  }

  /* ────────────────────────────────────────────────────── */
  /*  Transport                                            */
  /* ────────────────────────────────────────────────────── */

  async _play() {
    document.getElementById('playToggle').classList.add('is-playing');
    await this.engine.play();
  }

  _pause() {
    this.engine.pause();
    document.getElementById('playToggle').classList.remove('is-playing');
  }

  _stop() {
    this.engine.stop();
    const btn = document.getElementById('playToggle');
    if (btn) btn.classList.remove('is-playing');
    this.currentPlayIdx = -1;
    this.barGlow = new Float32Array(this.numCols).fill(0);
  }
}

/* ── Boot ──────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  window.app = new SkylineSoundApp();
});
