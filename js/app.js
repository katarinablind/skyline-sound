/**
 * Main application controller.
 *
 * Phases:
 *   empty     — landing hero with upload dropzone
 *   analyzing — cinematic sweep: filter overlay + silhouette draw-in + swatches
 *   ready     — image + silhouette + score + transport ready, not playing
 *   playing   — piano sonification active, playhead sweeps
 *
 * Canvases:
 *   imageCanvas    — landscape photograph
 *   overlayCanvas  — silhouette curve, filter sweep mask, playhead
 *   scoreCanvas    — 5-line staff with notes
 */

class SkylineSoundApp {
  static ANALYSIS_MS = 2000;

  constructor() {
    this.imageCanvas    = document.getElementById('imageCanvas');
    this.overlayCanvas  = document.getElementById('overlayCanvas');
    this.scoreCanvas    = document.getElementById('scoreCanvas');
    this.spectrumCanvas = document.getElementById('spectrumCanvas');
    this.canvasWrap     = document.getElementById('canvasContainer');
    this.scoreWrap      = this.scoreCanvas?.parentElement;
    this.sweepBar       = document.getElementById('sweepBar');

    this.imageCtx    = this.imageCanvas.getContext('2d');
    this.overlayCtx  = this.overlayCanvas.getContext('2d');
    this.scoreCtx    = this.scoreCanvas.getContext('2d');
    this.spectrumCtx = this.spectrumCanvas?.getContext('2d') || null;

    // Offscreen canvas for grayscale filter version of the photo
    this.filteredCanvas = document.createElement('canvas');
    this.filteredCtx = this.filteredCanvas.getContext('2d');

    // Dimensions (set on resize)
    this.W = 900;
    this.H = 360;
    this.scoreW = 900;
    this.scoreH = 124;

    // State
    this.phase = 'empty';
    this.heightProfile = null;
    this.analysis = null; // ColorAnalysis result
    this.currentPlayIdx = -1;
    this.silhouetteProgress = 0; // 0..1, animates during analyzing
    this.filterSweepProgress = 0; // 0..1
    this.dark = document.body.dataset.theme === 'dark';

    this.engine = new MusicEngine();
    this._resizeTimer = null;
    this._animId = null;
    this._lastSample = null;
    this._lastUploadSrc = null;

    this._sizeCanvases();
    this._bind();
    this._animate();
  }

  /* ────────────────────────────────────────────────────── */
  /*  Canvas sizing                                         */
  /* ────────────────────────────────────────────────────── */

  _sizeCanvases() {
    if (this.canvasWrap) {
      const rect = this.canvasWrap.getBoundingClientRect();
      this.W = Math.max(100, Math.round(rect.width * devicePixelRatio));
      this.H = Math.max(100, Math.round(rect.height * devicePixelRatio));
      this.imageCanvas.width = this.W;
      this.imageCanvas.height = this.H;
      this.overlayCanvas.width = this.W;
      this.overlayCanvas.height = this.H;
      this.filteredCanvas.width = this.W;
      this.filteredCanvas.height = this.H;
    }

    if (this.scoreWrap) {
      const rect = this.scoreWrap.getBoundingClientRect();
      this.scoreW = Math.max(100, Math.round(rect.width * devicePixelRatio));
      this.scoreH = Math.max(60, Math.round(rect.height * devicePixelRatio));
      this.scoreCanvas.width = this.scoreW;
      this.scoreCanvas.height = this.scoreH;
    }

    if (this.spectrumCanvas) {
      const rect = this.spectrumCanvas.getBoundingClientRect();
      this.spectrumW = Math.max(100, Math.round(rect.width * devicePixelRatio));
      this.spectrumH = Math.max(40, Math.round(rect.height * devicePixelRatio));
      this.spectrumCanvas.width = this.spectrumW;
      this.spectrumCanvas.height = this.spectrumH;
    }
  }

  _handleResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this._sizeCanvases();
      if (this._lastSample) {
        this._loadSample(this._lastSample);
      } else if (this._lastUploadSrc) {
        this._drawImageFromSrc(this._lastUploadSrc);
      }
    }, 150);
  }

  /* ────────────────────────────────────────────────────── */
  /*  Events                                                */
  /* ────────────────────────────────────────────────────── */

  _bind() {
    // Upload
    const fileInput = document.getElementById('fileInput');
    const dropzone = document.getElementById('dropzone');

    fileInput.addEventListener('change', e => {
      if (e.target.files.length) this._loadUpload(e.target.files[0]);
    });

    // Drag/drop
    if (dropzone) {
      ['dragover', 'dragenter'].forEach(evt => {
        dropzone.addEventListener(evt, e => {
          e.preventDefault();
          dropzone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'dragend', 'drop'].forEach(evt => {
        dropzone.addEventListener(evt, e => {
          e.preventDefault();
          dropzone.classList.remove('is-dragover');
        });
      });
      dropzone.addEventListener('drop', e => {
        if (e.dataTransfer.files.length) this._loadUpload(e.dataTransfer.files[0]);
      });
    }

    // Sample tiles (and legacy chips, if any)
    document.querySelectorAll('[data-sample]').forEach(btn => {
      btn.addEventListener('click', () => this._loadSample(btn.dataset.sample));
    });

    // Reset
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) resetBtn.addEventListener('click', () => this._reset());

    // Play toggle
    document.getElementById('playToggle').addEventListener('click', () => {
      if (this.engine.isPlaying) this._pause();
      else this._play();
    });

    // Volume
    const vol = document.getElementById('volumeSlider');
    if (vol) {
      this.engine.setVolume(+vol.value / 100);
      vol.addEventListener('input', () => {
        this.engine.setVolume(+vol.value / 100);
      });
    }

    // Tempo
    const tempo = document.getElementById('tempoSlider');
    tempo.addEventListener('input', () => {
      this.engine.setBpm(+tempo.value);
      this._updateReadout();
    });

    // Density
    const dens = document.getElementById('densitySlider');
    dens.addEventListener('input', () => {
      this.engine.setNoteCount(+dens.value);
      this._renderScore();
      this._updateReadout();
    });

    // Bass
    const bassToggle = document.getElementById('bassToggle');
    if (bassToggle) {
      bassToggle.addEventListener('change', () => {
        this.engine.setBassEnabled(bassToggle.checked);
      });
    }

    // Pedal — stretches piano notes into each other
    const pedalToggle = document.getElementById('pedalToggle');
    if (pedalToggle) {
      pedalToggle.addEventListener('change', () => {
        this.engine.setPedalEnabled(pedalToggle.checked);
      });
    }

    // Audio → visual callbacks
    this.engine.onNotePlay = idx => {
      this.currentPlayIdx = idx;
    };
    this.engine.onChordBar = bar => {
      this._activeChordBar = bar;
      this._renderChordStrip();
    };
    // Generative event markers: each perturbation (skip / harmony / echo /
    // ornament) gets a short-lived orange dot drawn above the corresponding
    // notehead, so you can SEE the randomization happen on the score.
    this._perturbMarkers = [];
    this.engine.onNotePerturb = (idx, info) => {
      this._perturbMarkers.push({
        i: idx,
        t0: performance.now(),
        skip: !!info.skip,
        kinds: info.kinds || [],
      });
    };

    // Resize
    window.addEventListener('resize', () => this._handleResize());

    // Dev-only: silhouette detection A/B toggle (?dev=1 in URL)
    this._bindDevTools();
  }

  /* ────────────────────────────────────────────────────── */
  /*  Dev tools (A/B silhouette detection toggle)           */
  /* ────────────────────────────────────────────────────── */
  /*
   * The DETECT: v1/v2/v3 pill used to mount here (gated by ?dev=1) for
   * cycling between the three silhouette-detection algorithms. V3 is the
   * active default and the sample overrides handle the remaining accuracy
   * gap, so the pill is no longer worth the UI real-estate. The body is
   * commented out below — uncomment if a future detector warrants A/B
   * comparison again. A ?detect=v1|v2|v3 URL param still forces a mode
   * even without the pill.
   */
  _bindDevTools() {
    const params = new URLSearchParams(location.search);
    const requested = params.get('detect');
    if (['v1', 'v2', 'v3'].includes(requested)) {
      window.__skylineDetectMode = requested;
    }
    return;

    /*  — Legacy DETECT pill (disabled) ————————————————————
    const devOn = params.has('dev') || params.has('detect');
    if (!devOn) return;

    window.__skylineDetectMode = ['v1', 'v2', 'v3'].includes(requested) ? requested : 'v3';

    const label = document.querySelector('.canvas-wrap')?.previousElementSibling
              || document.querySelector('.canvas-label');
    if (!label) return;

    const pill = document.createElement('button');
    pill.id = 'devDetectToggle';
    pill.type = 'button';
    pill.style.cssText = [
      'margin-left: auto',
      'font-family: var(--mono)',
      'font-size: 10px',
      'letter-spacing: 0.14em',
      'text-transform: uppercase',
      'padding: 2px 8px',
      'border: 1px solid var(--line-strong, #C4CAD3)',
      'border-radius: 10px',
      'background: transparent',
      'color: var(--ink-2, #6B7280)',
      'cursor: pointer',
      // Parent .canvas-label has pointer-events: none (so it doesn't block
      // interaction with the photo); re-enable it just for the clickable pill.
      'pointer-events: auto',
    ].join(';');
    const LABELS = {
      v1: 'sky-region growing (legacy)',
      v2: 'Sobel + continuity',
      v3: 'DP shortest-path (seam)',
    };
    const render = () => {
      const m = window.__skylineDetectMode;
      pill.textContent = `detect: ${m}`;
      pill.title = `Silhouette detection: ${LABELS[m] || m}. Click to cycle.`;
    };
    render();
    pill.addEventListener('click', () => {
      const order = ['v1', 'v2', 'v3'];
      const i = order.indexOf(window.__skylineDetectMode);
      window.__skylineDetectMode = order[(i + 1) % order.length];
      render();
      // Re-run analysis on the current image
      if (this._lastSample) {
        this._loadSample(this._lastSample);
      } else if (this._lastUploadSrc) {
        this._drawImageFromSrc(this._lastUploadSrc);
      }
    });

    // Keep pill text in sync if something else sets the mode programmatically
    this._refreshDevPill = render;
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.appendChild(pill);
    ———————————————————————————————————————————————————— */
  }

  /* ────────────────────────────────────────────────────── */
  /*  Phase transitions                                     */
  /* ────────────────────────────────────────────────────── */

  _setPhase(p) {
    this.phase = p;
    document.body.dataset.phase = p;

    const label = document.getElementById('phaseLabel');
    const status = document.getElementById('transportStatus');
    const resetBtn = document.getElementById('resetBtn');
    const stage = document.getElementById('stageSection');
    const hero = document.getElementById('heroSection');
    const transport = document.getElementById('transport');

    const labelText = {
      empty:     'READY',
      analyzing: 'ANALYZING',
      ready:     'READY · PLAY TO SONIFY',
      playing:   'PLAYING',
      paused:    'PAUSED',
    }[p] || p.toUpperCase();

    if (label) label.textContent = labelText;
    if (status) status.textContent = labelText;
    if (resetBtn) resetBtn.hidden = (p === 'empty');

    if (p === 'empty') {
      if (hero) hero.hidden = false;
      if (stage) stage.hidden = true;
      if (transport) transport.hidden = true;
    } else {
      if (hero) hero.hidden = true;
      if (stage) stage.hidden = false;
      if (transport) transport.hidden = false;
    }

    // Canvas sizes depend on stage visibility; resize after layout settles
    if (p === 'analyzing') {
      requestAnimationFrame(() => {
        this._sizeCanvases();
        this._startAnalysis();
      });
    }
  }

  _reset() {
    this.engine.stop();
    this._lastSample = null;
    this._lastUploadSrc = null;
    this.heightProfile = null;
    this.analysis = null;
    this.currentPlayIdx = -1;
    this.silhouetteProgress = 0;
    this._silhouetteCompletedAt = null;
    this._activeChordBar = -1;
    this._perturbMarkers = [];
    this.filterSweepProgress = 0;
    const btn = document.getElementById('playToggle');
    if (btn) btn.classList.remove('is-playing');
    this._setPhase('empty');
  }

  /* ────────────────────────────────────────────────────── */
  /*  Image loading                                         */
  /* ────────────────────────────────────────────────────── */

  async _loadSample(type) {
    this._lastSample = type;
    this._lastUploadSrc = null;
    this._setPhase('analyzing');
    // Wait a frame for layout
    await new Promise(r => requestAnimationFrame(r));
    this._sizeCanvases();
    await SampleGenerator.generate(this.imageCanvas, type);
    // Load any baked horizon override for this sample before the pipeline
    // runs — applyIfPresent is synchronous and depends on the cache being
    // populated. Missing files resolve to null and the detection is used.
    if (window.SilhouetteOverride) await window.SilhouetteOverride.preload(type);
    this._runAnalysisPipeline();
  }

  _loadUpload(file) {
    const reader = new FileReader();
    reader.onload = e => {
      this._lastSample = null;
      this._lastUploadSrc = e.target.result;
      this._setPhase('analyzing');
      requestAnimationFrame(() => {
        this._sizeCanvases();
        this._drawImageFromSrc(e.target.result);
      });
    };
    reader.readAsDataURL(file);
  }

  _drawImageFromSrc(src) {
    const img = new Image();
    img.onload = () => {
      this.imageCtx.clearRect(0, 0, this.W, this.H);
      const s = Math.max(this.W / img.width, this.H / img.height);
      const sw = img.width * s, sh = img.height * s;
      this.imageCtx.drawImage(img, (this.W - sw) / 2, (this.H - sh) / 2, sw, sh);
      this._runAnalysisPipeline();
    };
    img.src = src;
  }

  /* ────────────────────────────────────────────────────── */
  /*  Analysis pipeline                                     */
  /* ────────────────────────────────────────────────────── */

  _runAnalysisPipeline() {
    // Keep dev pill text in sync with whatever mode is actually active
    if (this._refreshDevPill) this._refreshDevPill();
    // Heavy sync work: silhouette + color analysis
    this.heightProfile = SilhouetteExtractor.extract(this.imageCanvas);

    // If this sample has a hand-tuned horizon baked into the repo at
    // assets/overrides/<id>.override.json, swap it in here. Downstream
    // pipeline is agnostic — notes / score / chord bed all derive off
    // the final heightProfile regardless of source.
    if (this._lastSample && window.SilhouetteOverride) {
      const { profile } = window.SilhouetteOverride.applyIfPresent(
        this._lastSample, this.heightProfile, this.W
      );
      this.heightProfile = profile;
    }

    this.analysis = ColorAnalysis.analyze(this.imageCanvas);

    // Pre-render grayscale/edge version for sweep filter
    this._prepareFilteredImage();

    // Apply analysis to engine
    const e = this.engine;
    e.setScale(this.analysis.mode);
    e.setScaleRoot(this.analysis.root);
    e.setBaseOctave(this.analysis.octave);
    e.setBpm(this.analysis.bpm);
    e.setAccentColor({
      saturation: this.analysis.accentSaturation,
      warmth:     this.analysis.accentWarmth,
    });
    // Image metrics drive the generative synth layer
    e.setImageMetrics({
      brightness:       this.analysis.brightness,
      contrast:         this.analysis.contrast,
      warmth:           this.analysis.accentWarmth,
      saturationSpread: this.analysis.saturationSpread,
    });
    e.setHeightProfile(this.heightProfile);

    // Sync controls to analyzed values
    const tempo = document.getElementById('tempoSlider');
    if (tempo) tempo.value = this.analysis.bpm;

    // Populate readout
    this._populateReadout();

    // Kick off the cinematic animation
    this._startAnalysis();
  }

  _prepareFilteredImage() {
    // Copy image, desaturate + boost contrast
    const src = this.imageCtx.getImageData(0, 0, this.W, this.H);
    const out = this.filteredCtx.createImageData(this.W, this.H);
    const d = src.data, o = out.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      // Cool-toned grayscale (slight blue tint)
      o[i]     = Math.min(255, gray * 0.95);
      o[i + 1] = Math.min(255, gray * 0.97);
      o[i + 2] = Math.min(255, gray * 1.05);
      o[i + 3] = 255;
    }
    this.filteredCtx.putImageData(out, 0, 0);
  }

  _startAnalysis() {
    const t0 = performance.now();
    const total = SkylineSoundApp.ANALYSIS_MS;
    // Reset silhouette settle timer so the next reveal plays in full
    this._silhouetteCompletedAt = null;

    // Reveal swatches staggered
    const swatches = document.querySelectorAll('.swatch');
    swatches.forEach((el, i) => {
      setTimeout(() => el.classList.add('is-in'), 400 + i * 120);
    });

    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / total);
      // Sweep runs from 0 → 1 during first 85% of duration
      this.filterSweepProgress = Math.min(1, t / 0.85);
      // Silhouette starts drawing at 25%, finishes at 95%
      this.silhouetteProgress = Math.max(0, Math.min(1, (t - 0.25) / 0.70));

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        this.filterSweepProgress = 1;
        this.silhouetteProgress = 1;
        this._setPhase('ready');
        // Render score once ready
        this._renderScore();
      }
    };
    tick();
  }

  /* ────────────────────────────────────────────────────── */
  /*  Readout panel                                         */
  /* ────────────────────────────────────────────────────── */

  _populateReadout() {
    const a = this.analysis;
    if (!a) return;

    // Swatches (reset state)
    const row = document.getElementById('swatchRow');
    if (row) {
      row.innerHTML = '';
      const pal = a.palette.slice(0, 5);
      for (const c of pal) {
        const el = document.createElement('div');
        el.className = 'swatch';
        el.style.background = `rgb(${c.r},${c.g},${c.b})`;
        row.appendChild(el);
      }
    }

    this._updateReadout();
  }

  _updateReadout() {
    const a = this.analysis;
    if (!a) return;

    const modeDisplay = {
      pentatonic: 'Pentatonic',
      major: 'Major (Ionian)',
      minor: 'Minor (Aeolian)',
      dorian: 'Dorian',
      lydian: 'Lydian',
      phrygian: 'Phrygian',
      mixolydian: 'Mixolydian',
      blues: 'Blues',
    };

    const scale = document.getElementById('scaleValue');
    const bpm = document.getElementById('bpmValue');
    const reg = document.getElementById('registerValue');
    const nc  = document.getElementById('noteCountValue');

    if (scale) scale.textContent = `${a.root} ${modeDisplay[a.mode] || a.mode}`;
    if (bpm)   bpm.textContent = `${this.engine.bpm} BPM`;
    if (reg)   reg.textContent = `C${a.octave}`;
    if (nc)    nc.textContent = `${this.engine.noteCount} events`;
  }

  /* ────────────────────────────────────────────────────── */
  /*  Render loop                                           */
  /* ────────────────────────────────────────────────────── */

  _animate() {
    const loop = () => {
      this._animId = requestAnimationFrame(loop);
      this._drawFrame();
    };
    loop();
  }

  _drawFrame() {
    if (this.phase === 'empty') return;

    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.W, this.H);

    // Layer 1: Filter sweep (grayscale revealed left→right during analysis)
    if (this.phase === 'analyzing' && this.filterSweepProgress < 1) {
      // Draw grayscale version clipped to left of sweep
      const sweepX = this.filterSweepProgress * this.W;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, sweepX, this.H);
      ctx.clip();
      ctx.drawImage(this.filteredCanvas, 0, 0);
      ctx.restore();

      // Gentle fade-back: the grayscale fades out behind the sweep
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - this.filterSweepProgress);
      ctx.drawImage(this.filteredCanvas, 0, 0);
      ctx.restore();
    }

    // Layer 2: Silhouette curve (draws in during analysis, stays after)
    if (this.silhouetteProgress > 0 && this.heightProfile) {
      this._drawSilhouetteCurve(ctx, this.silhouetteProgress);
    }

    // Layer 3: Playhead (only while playing)
    if (this.phase === 'playing' && this.currentPlayIdx >= 0) {
      this._drawPlayhead(ctx);
    }

    // Separate canvas: score
    if (this.phase === 'ready' || this.phase === 'playing' || this.phase === 'paused') {
      this._drawScoreOverlay();
    }

    // Separate canvas: live spectrum (always on when stage is visible)
    if (this.phase !== 'empty' && this.phase !== 'analyzing') {
      this._drawSpectrum();
    }
  }

  /*
   * Draw a live FFT spectrum as a soft filled curve + thin top outline.
   * Frequencies are log-spaced on X so the interesting musical range (~40 Hz
   * to 8 kHz) takes most of the width. Amplitudes are smoothed by Tone's
   * FFT node (smoothing: 0.72) so the shape moves gracefully rather than
   * flickering per-frame. Colors pick up the theme accent.
   */
  _drawSpectrum() {
    const ctx = this.spectrumCtx;
    if (!ctx) return;
    const W = this.spectrumW, H = this.spectrumH;
    ctx.clearRect(0, 0, W, H);

    const analyser = this.engine.analyser;
    if (!analyser) return;
    let values;
    try { values = analyser.getValue(); } catch (_) { return; }
    if (!values || !values.length) return;

    const N = values.length;
    const sampleRate = (Tone && Tone.context && Tone.context.sampleRate) || 44100;
    const nyquist = sampleRate / 2;
    const accent = this.dark ? '255, 150, 105' : '255, 122, 77';
    const ink = this.dark ? '245, 243, 239' : '26, 26, 26';

    // Log-frequency mapping: 40 Hz → 0, 8000 Hz → W
    const fMin = 40, fMax = 8000;
    const logMin = Math.log(fMin), logMax = Math.log(fMax);

    // Points: one sample per screen column for a clean curve
    const COLS = Math.min(W, 240);
    const amps = new Float32Array(COLS);
    const pts = new Array(COLS);
    let energySum = 0;
    for (let c = 0; c < COLS; c++) {
      const f = Math.exp(logMin + (c / (COLS - 1)) * (logMax - logMin));
      const bin = Math.min(N - 1, Math.max(0, Math.floor((f / nyquist) * N)));
      // Tone.FFT returns dB values (typically -100 .. 0). Remap to 0..1.
      const db = values[bin];
      const amp = Math.max(0, Math.min(1, (db + 90) / 72));
      amps[c] = amp;
      energySum += amp;
      pts[c] = { x: (c / (COLS - 1)) * W, y: H - amp * H * 0.88 };
    }

    // Peak-hold: per-column rolling max that decays a bit each frame.
    // Gives the classic "ghost of recent peaks" look that readbacks audio
    // transients even after they've gone quiet.
    if (!this._spectrumPeaks || this._spectrumPeaks.length !== COLS) {
      this._spectrumPeaks = new Float32Array(COLS);
    }
    const peaks = this._spectrumPeaks;
    const peakDecay = 0.018; // per-frame amplitude decay
    for (let c = 0; c < COLS; c++) {
      if (amps[c] > peaks[c]) peaks[c] = amps[c];
      else peaks[c] = Math.max(0, peaks[c] - peakDecay);
    }

    // Signal presence: if average amplitude is very low, treat as silence.
    // Dim the whole drawing so the spectrum "rests" when nothing's playing.
    const avgAmp = energySum / COLS;
    const isSilent = !this.engine.isPlaying || avgAmp < 0.03;
    // Ease the dim state so transitions don't flicker
    if (this._spectrumDim == null) this._spectrumDim = 1;
    const dimTarget = isSilent ? 0.22 : 1;
    this._spectrumDim += (dimTarget - this._spectrumDim) * 0.06;
    const dim = this._spectrumDim;

    // Baseline reference line (always drawn at full faintness)
    ctx.save();
    ctx.strokeStyle = `rgba(${ink}, 0.08)`;
    ctx.lineWidth = Math.max(0.5, devicePixelRatio * 0.5);
    ctx.beginPath();
    ctx.moveTo(0, H - 1);
    ctx.lineTo(W, H - 1);
    ctx.stroke();
    ctx.restore();

    // Subtle frequency axis markers at 100 Hz / 1 kHz / 10 kHz.
    // Thin vertical lines + tiny label, in the ink color so they don't
    // compete with the accent-colored spectrum.
    const marks = [
      { f: 100,   label: '100' },
      { f: 1000,  label: '1k'  },
      { f: 10000, label: '10k' },
    ];
    ctx.save();
    ctx.strokeStyle = `rgba(${ink}, 0.06)`;
    ctx.lineWidth = Math.max(0.5, devicePixelRatio * 0.5);
    ctx.fillStyle = `rgba(${ink}, 0.28)`;
    const fontPx = Math.max(8, Math.round(9 * devicePixelRatio));
    ctx.font = `400 ${fontPx}px "IBM Plex Mono", monospace`;
    ctx.textBaseline = 'top';
    for (const m of marks) {
      if (m.f < fMin || m.f > fMax) continue;
      const x = ((Math.log(m.f) - logMin) / (logMax - logMin)) * W;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillText(m.label, x + 3 * devicePixelRatio, 2 * devicePixelRatio);
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = dim;

    // Filled soft gradient area
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, `rgba(${accent}, 0.45)`);
    grad.addColorStop(1, `rgba(${accent}, 0.05)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    // Top outline stroke (live curve)
    ctx.strokeStyle = `rgba(${accent}, 0.95)`;
    ctx.lineWidth = Math.max(1, devicePixelRatio * 1.2);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = `rgba(${accent}, 0.35)`;
    ctx.shadowBlur = 5;
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Peak-hold outline — thinner, brighter, drawn above the live curve
    ctx.strokeStyle = `rgba(${accent}, 0.55)`;
    ctx.lineWidth = Math.max(0.75, devicePixelRatio * 0.75);
    ctx.beginPath();
    for (let c = 0; c < COLS; c++) {
      const x = (c / (COLS - 1)) * W;
      const y = H - peaks[c] * H * 0.88;
      if (c === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.restore();
  }

  /* ────────────────────────────────────────────────────── */
  /*  Silhouette curve (progressive draw)                   */
  /* ────────────────────────────────────────────────────── */

  _drawSilhouetteCurve(ctx, progress) {
    if (!this.heightProfile) return;
    const padY = this.H * 0.08;
    const h = this.H - padY * 2;
    const endIdx = Math.floor(this.heightProfile.length * progress);
    if (endIdx < 2) return;

    const accent = this.dark ? '255, 150, 105' : '255, 122, 77';

    // After progress hits 1, settle & dim to ~40% so the line doesn't
    // compete with the score below. Tracked via a timestamp.
    if (progress >= 1 && this._silhouetteCompletedAt == null) {
      this._silhouetteCompletedAt = performance.now();
    }
    let settleFactor = 1;
    if (this._silhouetteCompletedAt != null) {
      const dt = performance.now() - this._silhouetteCompletedAt;
      const k = Math.min(1, dt / 900);                 // 900ms ease-out
      const eased = 1 - Math.pow(1 - k, 3);
      settleFactor = 1 - eased * 0.6;                  // 1.0 → 0.4
    }

    ctx.save();

    // The line itself glows like the accent — a pen of light tracing the ridge.
    ctx.shadowColor = `rgba(${accent}, ${0.55 * settleFactor})`;
    ctx.shadowBlur = 10 * settleFactor + 4;
    ctx.strokeStyle = `rgba(${accent}, ${0.95 * settleFactor})`;
    ctx.lineWidth = Math.max(1.2, devicePixelRatio * 1.6);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.beginPath();
    for (let i = 0; i < endIdx; i++) {
      const x = (i / (this.heightProfile.length - 1)) * this.W;
      const y = padY + (1 - this.heightProfile[i]) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // Leading dot at the head of the line during draw-in
    if (progress < 1) {
      const i = endIdx - 1;
      const x = (i / (this.heightProfile.length - 1)) * this.W;
      const y = padY + (1 - this.heightProfile[i]) * h;
      ctx.save();
      ctx.fillStyle = `rgba(${accent}, 1)`;
      ctx.shadowColor = `rgba(${accent}, 0.9)`;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, devicePixelRatio * 3.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /* ────────────────────────────────────────────────────── */
  /*  Playhead                                              */
  /* ────────────────────────────────────────────────────── */

  _drawPlayhead(ctx) {
    const progress = (this.currentPlayIdx + 0.5) / this.engine.noteCount;
    const px = progress * this.W;
    const accent = this.dark ? '255, 150, 105' : '255, 122, 77';
    ctx.save();
    ctx.shadowColor = `rgba(${accent}, 0.55)`;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = `rgba(${accent}, 0.9)`;
    ctx.lineWidth = Math.max(1, devicePixelRatio);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, this.H);
    ctx.stroke();
    ctx.restore();
  }

  /* ────────────────────────────────────────────────────── */
  /*  5-line staff score                                    */
  /* ────────────────────────────────────────────────────── */
  /*  Treble clef reference: MIDI 64 = E4 = bottom staff line.
   *  Each diatonic step is half a line spacing.
   *  Line positions (bottom→top): E4(64), G4(67), B4(71), D5(74), F5(77).
   */

  _renderScore() {
    this._renderStaticStaff();
    this._renderChordStrip();
  }

  /*
   * Chord-strip row (below score): one cell per 8-note bar, showing both
   * the chord name (e.g. "F♯m") as the primary label and the roman numeral
   * (I / IV / V) as a small secondary label underneath — so you can read
   * either the functional harmony or the absolute chord at a glance. The
   * currently-playing bar glows the accent color.
   */
  _renderChordStrip() {
    const strip = document.getElementById('chordStrip');
    if (!strip) return;
    const degs  = this.engine.chordDegrees || [];
    const names = this.engine.chordNames   || [];
    if (degs.length === 0) { strip.innerHTML = ''; strip.hidden = true; return; }
    strip.hidden = false;

    const active = this._activeChordBar ?? -1;

    // Reuse cells if count hasn't changed (avoids layout thrash while playing)
    const existing = strip.querySelectorAll('.chord-cell');
    if (existing.length !== degs.length) {
      strip.innerHTML = '';
      for (let i = 0; i < degs.length; i++) {
        const cell = document.createElement('div');
        cell.className = 'chord-cell';
        // Wrap name + degree in an inline group so `justify-content: center`
        // on the cell treats them as a single unit — neither floats to one
        // side when the bar is wide.
        const inner = document.createElement('span');
        inner.className = 'chord-cell-inner';
        const name = document.createElement('span');
        name.className = 'chord-cell-name';
        name.textContent = names[i] || '';
        const deg = document.createElement('span');
        deg.className = 'chord-cell-deg';
        deg.textContent = degs[i];
        inner.appendChild(name);
        inner.appendChild(deg);
        cell.appendChild(inner);
        strip.appendChild(cell);
      }
    } else {
      // Just update labels in place
      existing.forEach((cell, i) => {
        const nm  = cell.querySelector('.chord-cell-name');
        const dg  = cell.querySelector('.chord-cell-deg');
        if (nm) nm.textContent = names[i] || '';
        if (dg) dg.textContent = degs[i];
      });
    }

    // Active state
    strip.querySelectorAll('.chord-cell').forEach((cell, i) => {
      cell.classList.toggle('is-active', i === active);
    });
  }

  _computeStaffLayout() {
    const W = this.scoreW, H = this.scoreH;
    const lineSpacing = H * 0.115;
    const stepSize = lineSpacing / 2;

    // Auto-pick clef. Treble bottom line = E4 (64); if the melody sits below
    // that on average, bass clef keeps the notes centered on the staff with
    // far fewer ledger lines — so a mountain with a low register (Rainier,
    // baseOctave 3) renders in bass, while a cityscape at baseOctave 5 stays
    // treble. Also bias toward bass if ANY note would require 4+ ledger
    // positions below the treble staff.
    const notes = (this.engine && this.engine.notes) || [];
    let avgMidi = 71;
    let minMidi = 127;
    let maxMidi = 0;
    if (notes.length) {
      let sum = 0;
      for (const n of notes) {
        sum += n.midi;
        if (n.midi < minMidi) minMidi = n.midi;
        if (n.midi > maxMidi) maxMidi = n.midi;
      }
      avgMidi = sum / notes.length;
    }
    // Use bass when the mean note is below E4, or when the lowest note drops
    // below A3 (which is already 3 ledger positions below the treble staff).
    const clef = (avgMidi < 64 || minMidi < 57) ? 'bass' : 'treble';
    const refMidi = clef === 'bass' ? 43 : 64;

    // Compute each note's letter-step distance from the clef's bottom-line
    // reference so we can position the staff dynamically: the staff shifts
    // up or down within the canvas until every notehead fits inside it,
    // regardless of how peak-y or valley-y the silhouette is.
    const pcToLetterStep = { 0: 0, 1: 0, 2: 1, 3: 1, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4, 9: 5, 10: 5, 11: 6 };
    const stepIdx = (m) => (Math.floor(m / 12) - 1) * 7 + pcToLetterStep[((m % 12) + 12) % 12];
    const refStep = stepIdx(refMidi);
    const maxStep = notes.length ? stepIdx(maxMidi) - refStep : 4;
    const minStep = notes.length ? stepIdx(minMidi) - refStep : 0;

    // Margins guarantee room for the highest notehead above (small) and the
    // lowest notehead below (small). Staff lines + stems fill the rest.
    const topMargin = lineSpacing * 0.6;
    const botMargin = lineSpacing * 0.6;

    // bottomLineY must satisfy:
    //   bottomLineY − maxStep*stepSize ≥ topMargin    (highest note has headroom)
    //   bottomLineY − minStep*stepSize ≤ H − botMargin (lowest note has footroom)
    const minBottomLine = maxStep * stepSize + topMargin;
    const maxBottomLine = minStep * stepSize + H - botMargin;

    // Also keep the full staff itself on-screen (top line ≥ 0, bottom ≤ H).
    const staffMinBottom = 4 * lineSpacing;
    const staffMaxBottom = H;

    let bottomLineY;
    const lo = Math.max(minBottomLine, staffMinBottom);
    const hi = Math.min(maxBottomLine, staffMaxBottom);
    if (lo <= hi) {
      bottomLineY = (lo + hi) / 2;
    } else {
      // Range too wide to fully fit — prioritize the "above" direction so
      // the melodic peaks stay visible (ledger lines below are easier to
      // read as partial glyphs than peaks bleeding off the top).
      bottomLineY = lo;
    }

    const centerY = bottomLineY - 2 * lineSpacing;
    const staffLines = [];
    for (let i = 0; i < 5; i++) {
      staffLines.push(centerY + lineSpacing * 2 - i * lineSpacing);
    }

    const keySig = this._computeKeySignature();
    // Bass clef glyph is narrower and sits entirely inside the staff — no
    // swooping descender — so it needs less horizontal gutter than treble.
    const clefW = H * (clef === 'bass' ? 0.36 : 0.48);
    const keySigW = keySig.letters.length * lineSpacing * 0.68;
    const padL = clefW + keySigW + lineSpacing * 1.2;
    // Large right gutter so the final notehead + stem sits well inside the
    // staff, and the staff line itself terminates visibly before the card
    // edge (no "cut off" feeling).
    const padR = lineSpacing * 5.5;
    return { W, H, lineSpacing, staffLines, padL, padR, clefW, keySig, clef, refMidi };
  }

  _renderStaticStaff() {
    const ctx = this.scoreCtx;
    ctx.clearRect(0, 0, this.scoreW, this.scoreH);

    if (!this.engine.notes || this.engine.notes.length === 0) return;
    const notes = this.engine.notes;

    const L = this._computeStaffLayout();
    this._staffLayout = L;

    // Ink tokens (theme-aware)
    const fg = this.dark ? '245,243,239' : '26, 26, 26';
    const inkSoft   = `rgba(${fg}, 0.22)`;
    const inkMed    = `rgba(${fg}, 0.55)`;
    const inkStrong = `rgba(${fg}, 0.78)`;

    // ── Staff lines ───────────────────────────────────
    ctx.save();
    ctx.strokeStyle = inkSoft;
    ctx.lineWidth = Math.max(0.5, L.lineSpacing * 0.085);
    const staffLeft = L.clefW * 0.12;
    const staffRight = L.W - L.padR;
    for (const y of L.staffLines) {
      ctx.beginPath();
      ctx.moveTo(staffLeft, y);
      ctx.lineTo(staffRight, y);
      ctx.stroke();
    }
    ctx.restore();

    // ── Clef (treble 𝄞 or bass 𝄢, auto-picked to fit the note range) ──
    ctx.save();
    ctx.fillStyle = inkStrong;
    ctx.textAlign = 'left';
    if (L.clef === 'bass') {
      // Bass clef: sits entirely inside the staff, centered on F3 (4th line
      // from bottom = staffLines[3]). Compact glyph, smaller font. The two
      // dots flanking the F3 line give the clef its reference pitch.
      ctx.font = `400 ${L.H * 0.56}px "STIX Two Text", "Bravura", serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText('\u{1D122}', L.clefW * 0.22, L.staffLines[3] - L.lineSpacing * 0.05);
    } else {
      // Treble clef: wraps around G4 (line 2 from bottom), extends above and
      // below the staff. Needs a taller glyph and baseline rooted near E4.
      ctx.font = `400 ${L.H * 0.82}px "STIX Two Text", "Bravura", serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('\u{1D11E}', L.clefW * 0.20, L.staffLines[0] + L.lineSpacing * 0.65);
    }
    ctx.restore();

    // ── Key signature ─────────────────────────────────
    if (L.keySig.letters.length) {
      this._drawKeySignature(ctx, L.keySig, L.clefW + L.lineSpacing * 0.2, L.staffLines, L.lineSpacing, L.clef, L.refMidi);
    }

    // ── Notes ─────────────────────────────────────────
    const contentW = L.W - L.padL - L.padR;
    const colW = contentW / notes.length;
    this._noteLayout = notes.map((n, i) => {
      const cx = L.padL + colW * (i + 0.5);
      const y = pitchToY(n.midi, L.staffLines, L.lineSpacing, L.refMidi);
      return { cx, y, midi: n.midi, name: n.name };
    });

    for (const n of this._noteLayout) {
      this._drawNotehead(ctx, n, colW, L.staffLines, L.lineSpacing, false);
    }

    // ── Barlines every 8 notes ────────────────────────
    ctx.save();
    ctx.strokeStyle = `rgba(${fg}, 0.12)`;
    ctx.lineWidth = Math.max(0.5, L.lineSpacing * 0.06);
    for (let i = 8; i < notes.length; i += 8) {
      const x = L.padL + colW * i;
      ctx.beginPath();
      ctx.moveTo(x, L.staffLines[4]);
      ctx.lineTo(x, L.staffLines[0]);
      ctx.stroke();
    }
    ctx.restore();
  }

  /*
   * Derives the key signature (ordered list of sharps or flats) from the
   * current scaleRoot + scale mode. This lets us draw accidentals once at
   * the start of the staff instead of next to every affected note —
   * matching standard music engraving.
   */
  _computeKeySignature() {
    const LETTERS = ['C','D','E','F','G','A','B'];
    const LETTER_TO_PC = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
    const SHARP_ORDER  = ['F','C','G','D','A','E','B'];
    const FLAT_ORDER   = ['B','E','A','D','G','C','F'];

    const rootName  = this.engine.scaleRoot;
    const intervals = MusicEngine.SCALES[this.engine.scale] || [];
    if (!rootName || intervals.length === 0) return { type: 'none', letters: [] };

    const rootLetter = rootName[0];
    const rootAcc = rootName.includes('#') ? 1 : rootName.includes('b') ? -1 : 0;
    const rootPc = (LETTER_TO_PC[rootLetter] + rootAcc + 12) % 12;
    const startIdx = LETTERS.indexOf(rootLetter);

    // Letter → accidental offset (one entry per letter that appears in scale)
    const letterAcc = {};
    for (let i = 0; i < intervals.length; i++) {
      let letter;
      if (intervals.length === 7) {
        // Diatonic: walk letters in order from root
        letter = LETTERS[(startIdx + i) % 7];
      } else if (intervals.length === 5 &&
                 intervals[0] === 0 && intervals[1] === 2 && intervals[2] === 4 &&
                 intervals[3] === 7 && intervals[4] === 9) {
        // Major pentatonic: derive letters as 1st, 2nd, 3rd, 5th, 6th major-scale degrees
        const pentaSteps = [0, 1, 2, 4, 5];
        letter = LETTERS[(startIdx + pentaSteps[i]) % 7];
      } else {
        // Other non-diatonic: assign nearest natural letter (best-effort spelling)
        const targetPc = (rootPc + intervals[i]) % 12;
        let best = 'C', bestDiff = 12;
        for (const lt of LETTERS) {
          const d = (targetPc - LETTER_TO_PC[lt] + 12) % 12;
          if (d <= 2 && d < bestDiff) { bestDiff = d; best = lt; }
        }
        letter = best;
      }
      const naturalPc = LETTER_TO_PC[letter];
      const scalePc = (rootPc + intervals[i]) % 12;
      let diff = (scalePc - naturalPc + 12) % 12;
      if (diff > 6) diff -= 12;
      if (diff >= -2 && diff <= 2 && !(letter in letterAcc)) {
        letterAcc[letter] = diff;
      }
    }

    const sharps = [], flats = [];
    for (const [lt, a] of Object.entries(letterAcc)) {
      if (a === 1) sharps.push(lt);
      else if (a === -1) flats.push(lt);
    }

    if (sharps.length && !flats.length) {
      return { type: 'sharp', letters: SHARP_ORDER.filter(l => sharps.includes(l)) };
    }
    if (flats.length && !sharps.length) {
      return { type: 'flat', letters: FLAT_ORDER.filter(l => flats.includes(l)) };
    }
    if (!sharps.length && !flats.length) {
      return { type: 'none', letters: [] };
    }
    // Mixed spelling (rare): pick the majority representation
    return sharps.length >= flats.length
      ? { type: 'sharp', letters: SHARP_ORDER.filter(l => sharps.includes(l)) }
      : { type: 'flat',  letters: FLAT_ORDER.filter(l => flats.includes(l)) };
  }

  _drawKeySignature(ctx, keySig, startX, staffLines, lineSpacing, clef = 'treble', refMidi = 64) {
    // Traditional staff positions — per-clef, expressed as MIDI pitches.
    // Sharps/flats sit one octave lower in bass clef than in treble so they
    // stay centered on the staff.
    const SHARP_MIDI_TREBLE = { F: 77, C: 72, G: 79, D: 74, A: 69, E: 76, B: 71 };
    const FLAT_MIDI_TREBLE  = { B: 71, E: 76, A: 69, D: 74, G: 67, C: 72, F: 65 };
    const SHARP_MIDI_BASS   = { F: 53, C: 48, G: 55, D: 50, A: 45, E: 52, B: 47 };
    const FLAT_MIDI_BASS    = { B: 47, E: 52, A: 45, D: 50, G: 43, C: 48, F: 41 };

    const isSharp = keySig.type === 'sharp';
    const glyph   = isSharp ? '\u266F' : '\u266D';
    const midiMap = clef === 'bass'
      ? (isSharp ? SHARP_MIDI_BASS : FLAT_MIDI_BASS)
      : (isSharp ? SHARP_MIDI_TREBLE : FLAT_MIDI_TREBLE);
    const step    = lineSpacing * 0.68;
    const yFudge  = isSharp ? lineSpacing * 0.02 : -lineSpacing * 0.1;
    const fg = this.dark ? '245,243,239' : '26, 26, 26';

    ctx.save();
    ctx.fillStyle = `rgba(${fg}, 0.72)`;
    ctx.font = `${lineSpacing * 1.9}px "STIX Two Text", "Bravura", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < keySig.letters.length; i++) {
      const midi = midiMap[keySig.letters[i]];
      const y = pitchToY(midi, staffLines, lineSpacing, refMidi);
      ctx.fillText(glyph, startX + (i + 0.5) * step, y + yFudge);
    }
    ctx.restore();
  }

  _drawNotehead(ctx, n, colW, staffLines, lineSpacing, isActive) {
    const topY = staffLines[4];
    const botY = staffLines[0];
    const fg = this.dark ? '245,243,239' : '26, 26, 26';

    // Ledger lines
    const stepSize = lineSpacing / 2;
    const stepsAbove = Math.max(0, Math.round((topY - stepSize - n.y) / lineSpacing));
    const stepsBelow = Math.max(0, Math.round((n.y - botY - stepSize) / lineSpacing));

    ctx.save();
    ctx.strokeStyle = `rgba(${fg}, 0.30)`;
    ctx.lineWidth = Math.max(0.5, lineSpacing * 0.085);
    ctx.lineCap = 'round';
    const ledgerHalfW = lineSpacing * 0.72;
    for (let s = 1; s <= stepsAbove; s++) {
      const y = topY - s * lineSpacing;
      ctx.beginPath();
      ctx.moveTo(n.cx - ledgerHalfW, y);
      ctx.lineTo(n.cx + ledgerHalfW, y);
      ctx.stroke();
    }
    for (let s = 1; s <= stepsBelow; s++) {
      const y = botY + s * lineSpacing;
      ctx.beginPath();
      ctx.moveTo(n.cx - ledgerHalfW, y);
      ctx.lineTo(n.cx + ledgerHalfW, y);
      ctx.stroke();
    }
    ctx.restore();

    // Notehead (tilted ellipse, softer ink)
    const accent = this.dark ? '255, 150, 105' : '255, 122, 77';
    // Noteheads + stems are drawn at full opacity so they read as proper
    // engraved ink against the lighter staff lines.
    const noteInk = isActive
      ? `rgba(${accent}, 1)`
      : `rgba(${fg}, 1)`;
    ctx.save();
    ctx.translate(n.cx, n.y);
    ctx.rotate(-0.32);
    ctx.fillStyle = noteInk;
    if (isActive) {
      ctx.shadowColor = `rgba(${accent}, 0.45)`;
      ctx.shadowBlur = 6;
    }
    ctx.beginPath();
    ctx.ellipse(0, 0, lineSpacing * 0.55, lineSpacing * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Stem — thinner & softer
    const stemLen = lineSpacing * 3.25;
    const midStaff = (topY + botY) / 2;
    const stemUp = n.y >= midStaff;
    ctx.save();
    ctx.strokeStyle = noteInk;
    ctx.lineWidth = Math.max(0.75, lineSpacing * 0.08);
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (stemUp) {
      const sx = n.cx + lineSpacing * 0.5;
      ctx.moveTo(sx, n.y - lineSpacing * 0.05);
      ctx.lineTo(sx, n.y - stemLen);
    } else {
      const sx = n.cx - lineSpacing * 0.5;
      ctx.moveTo(sx, n.y + lineSpacing * 0.05);
      ctx.lineTo(sx, n.y + stemLen);
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawScoreOverlay() {
    this._renderStaticStaff();

    const L = this._staffLayout;
    if (!L) return;
    const ctx = this.scoreCtx;
    const accent = this.dark ? '255, 150, 105' : '255, 122, 77';
    const notes = this.engine.notes;
    const contentW = L.W - L.padL - L.padR;
    const colW = notes && notes.length ? contentW / notes.length : 1;

    // Generative markers — small glowing dot above each recently-perturbed
    // note. Different positions per kind so stacked events are readable.
    this._drawPerturbMarkers(ctx, L, accent);

    if (this.currentPlayIdx < 0 || !this._noteLayout ||
        !this._noteLayout[this.currentPlayIdx]) return;
    const n = this._noteLayout[this.currentPlayIdx];

    // Soft vertical highlight band
    ctx.save();
    ctx.fillStyle = `rgba(${accent}, 0.09)`;
    ctx.fillRect(
      n.cx - colW / 2,
      L.staffLines[4] - L.lineSpacing * 0.8,
      colW,
      (L.staffLines[0] - L.staffLines[4]) + L.lineSpacing * 1.6
    );
    ctx.restore();

    this._drawNotehead(this.scoreCtx, n, colW, L.staffLines, L.lineSpacing, true);
  }

  /*
   * Draw the generative-event markers: small orange dots above the staff
   * at the positions of notes that were perturbed (skip / harmony / echo /
   * ornament). Each dot fades out over ~1.6 seconds. If multiple kinds
   * fire on one note, we draw them in a horizontal cluster so everything
   * stays inside the thin strip above the top staff line.
   *
   * Skips are drawn as hollow rings (nothing was played), others as
   * filled dots (something extra was played). Subtle enough to not
   * overwhelm the score, clear enough to read as "that note got a twist".
   */
  _drawPerturbMarkers(ctx, L, accent) {
    if (!this._perturbMarkers || !this._perturbMarkers.length || !this._noteLayout) return;
    const now = performance.now();
    const LIFE = 1600;
    // Drop expired markers
    this._perturbMarkers = this._perturbMarkers.filter(m => now - m.t0 < LIFE);

    // One horizontal row just above the top staff line
    const topY = L.staffLines[4];
    const cy = topY - L.lineSpacing * 0.85;
    const r = L.lineSpacing * 0.18;
    const gap = L.lineSpacing * 0.5;

    for (const m of this._perturbMarkers) {
      const layout = this._noteLayout[m.i];
      if (!layout) continue;
      const age = now - m.t0;
      const t = age / LIFE;
      const pop = Math.min(1, age / 80);      // pop-in
      const alpha = pop * Math.max(0, 1 - Math.pow(t, 1.4));

      const kinds = m.skip ? ['skip'] : m.kinds;
      // Center the cluster around the notehead's x
      const clusterW = (kinds.length - 1) * gap;
      const startX = layout.cx - clusterW / 2;

      ctx.save();
      ctx.shadowColor = `rgba(${accent}, ${alpha * 0.55})`;
      ctx.shadowBlur = 6;
      ctx.lineWidth = Math.max(1, L.lineSpacing * 0.1);
      for (let j = 0; j < kinds.length; j++) {
        const kind = kinds[j];
        const x = startX + j * gap;
        ctx.beginPath();
        ctx.arc(x, cy, r, 0, Math.PI * 2);
        if (kind === 'skip') {
          ctx.strokeStyle = `rgba(${accent}, ${alpha})`;
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(${accent}, ${alpha})`;
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  /* ────────────────────────────────────────────────────── */
  /*  Transport                                             */
  /* ────────────────────────────────────────────────────── */

  async _play() {
    document.getElementById('playToggle').classList.add('is-playing');
    const status = document.getElementById('transportStatus');
    const label = document.getElementById('phaseLabel');
    if (this.engine.loading || !this.engine._init) {
      if (status) status.textContent = 'LOADING PIANO';
      if (label) label.textContent = 'LOADING PIANO';
    }
    await this.engine.play();
    this._setPhase('playing');
  }

  _pause() {
    this.engine.pause();
    document.getElementById('playToggle').classList.remove('is-playing');
    this._setPhase('paused');
  }

  _stop() {
    this.engine.stop();
    const btn = document.getElementById('playToggle');
    if (btn) btn.classList.remove('is-playing');
    this.currentPlayIdx = -1;
    this._activeChordBar = -1;
    this._perturbMarkers = [];
    this._renderChordStrip();
  }
}

/* ── Helper: MIDI pitch → staff Y position ─────────────── */
/*
 * Each diatonic step (C-maj letter step) = 1/2 line spacing. The reference
 * is the bottom staff line; its MIDI pitch depends on the clef:
 *   treble → E4 (64)
 *   bass   → G2 (43)
 * Accidentals are ignored for Y (drawn as separate glyphs via key sig).
 */
function pitchToY(midi, staffLines, lineSpacing, refMidi = 64) {
  const bottomLineY = staffLines[0];
  const stepSize = lineSpacing / 2;

  const pcToLetterStep = { 0: 0, 1: 0, 2: 1, 3: 1, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4, 9: 5, 10: 5, 11: 6 };

  const stepIndexOf = (m) => {
    const pc = m % 12;
    const oct = Math.floor(m / 12) - 1;
    return oct * 7 + pcToLetterStep[pc];
  };

  const stepsFromRef = stepIndexOf(midi) - stepIndexOf(refMidi);
  return bottomLineY - stepsFromRef * stepSize;
}

/* ── Boot ──────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  window.app = new SkylineSoundApp();
});
