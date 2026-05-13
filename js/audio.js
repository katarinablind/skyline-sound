/**
 * Layered sonification engine.
 *
 *   Piano (melody)    — Salamander Grand Piano samples, one event per step.
 *                       Velocity driven by silhouette slope (|Δh|), with
 *                       small timing jitter + long release for pedal feel.
 *   Cello (strings)   — Sustained chord every 8 steps, derived from the
 *                       average silhouette height in that bar (I / IV / V
 *                       voiced as root + 3rd + 5th + octave).
 *   Bass              — Piano root, two octaves below, every 4 steps.
 *   Generative        — Per-note probabilistic perturbations on the piano
 *                       melody itself (skip, harmony, echo, ornament).
 *                       Probabilities are driven by image metrics —
 *                       dramatic images get more activity, hazy ones less.
 *                       Eno-style: emergent variation inside a fixed grid.
 *
 * Signal chain: samplers → shared reverb → destination.
 * Strings level is scaled by the palette's accent saturation so vivid
 * images get a lusher bed, desaturated ones stay nearly piano-only.
 */

class MusicEngine {
  constructor() {
    this.piano   = null;
    this.strings = null;
    this.reverb  = null;

    this.isPlaying = false;
    this.isPaused = false;
    this.loop = true;
    this.bpm = 68;
    this.noteCount = 32;
    this.scale = 'pentatonic';
    this.scaleRoot = 'C';     // set by color analysis
    this.baseOctave = 4;      // set by color analysis (lightness)
    this.bassEnabled = true;
    this.pedalEnabled = false;// long-release piano toggle
    this.stringsLevel = 0.6;  // set by accent saturation (0..1)
    this.heightProfile = null;
    this.notes = [];          // [{ name: 'C4', midi: 60 }, ...]
    this.chords = [];         // per-bar chord voicings
    this.chordDegrees = [];   // per-bar roman numeral
    this.chordNames = [];     // per-bar display chord name (e.g. 'F#m')
    this.velocityProfile = [];// per-note velocity, from silhouette slope
    this.currentIndex = 0;
    this.currentChordBar = -1;
    this.scheduledId = null;

    // Generative perturbation parameters (Eno-style). Probabilities per note.
    // Populated by setImageMetrics().
    this.generativeEnabled = true;
    this.genParams = {
      skip:     0.03,   // probability of silencing this note
      harmony:  0.08,   // probability of layering a 3rd above
      echo:     0.05,   // probability of a softer delayed repeat
      ornament: 0.04,   // probability of an upper-neighbor grace note after
    };

    this.onNotePlay = null;
    this.onChordPlay = null;
    this.onChordBar = null;  // fires with bar index when strings change chord
    this.onNotePerturb = null; // fires (i, { skip, extras }) when generative fires
    this.onLoadProgress = null;

    this.loading = false;
    this._init = false;
  }

  /* ── Scales (interval sets) ──────────────────────────── */

  static SCALES = {
    pentatonic: [0, 2, 4, 7, 9],
    major:      [0, 2, 4, 5, 7, 9, 11],   // Ionian
    minor:      [0, 2, 3, 5, 7, 8, 10],   // Aeolian
    dorian:     [0, 2, 3, 5, 7, 9, 10],
    lydian:     [0, 2, 4, 6, 7, 9, 11],
    phrygian:   [0, 1, 3, 5, 7, 8, 10],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    blues:      [0, 3, 5, 6, 7, 10],
  };

  static NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  /* ── Sampler anchors (local assets) ──────────────────── */

  static PIANO_SAMPLES = {
    'A1': 'A1.mp3',
    'C2': 'C2.mp3',
    'C3': 'C3.mp3',
    'A3': 'A3.mp3',
    'C4': 'C4.mp3',
    'C5': 'C5.mp3',
    'A5': 'A5.mp3',
    'C6': 'C6.mp3',
  };

  static CELLO_SAMPLES = {
    'C2': 'C2.mp3',
    'A2': 'A2.mp3',
    'C3': 'C3.mp3',
    'A3': 'A3.mp3',
    'C4': 'C4.mp3',
    'A4': 'A4.mp3',
  };

  /* ── Init (requires user gesture) ───────────────────── */

  async init() {
    if (this._init) return;
    await Tone.start();

    // Warm reverb — long tail, blooms into ensemble feel
    this.reverb = new Tone.Reverb({ decay: 7, wet: 0.42 });
    await this.reverb.generate();
    // FFT analyzer tapped from the main bus so the visual spectrum reflects
    // exactly what's being played (piano + cello + generative extras).
    this.analyser = new Tone.FFT({ size: 512, smoothing: 0.72 });
    this.reverb.fan(Tone.Destination, this.analyser);

    this.loading = true;

    // Load piano + cello samplers in parallel
    const pianoLoad = new Promise((resolve, reject) => {
      this.piano = new Tone.Sampler({
        urls: { ...MusicEngine.PIANO_SAMPLES },
        baseUrl: 'assets/piano/',
        release: 3.2,      // long release = pedal-like sustain
        volume: -6,
        onload: resolve,
        onerror: (e) => { console.error('Piano load error:', e); reject(e); },
      }).connect(this.reverb);
    });

    const celloLoad = new Promise((resolve, reject) => {
      this.strings = new Tone.Sampler({
        urls: { ...MusicEngine.CELLO_SAMPLES },
        baseUrl: 'assets/cello/',
        attack: 1.2,       // slow bowed swell
        release: 4.0,      // long tail blends chord transitions
        volume: -14,
        onload: resolve,
        onerror: (e) => { console.error('Cello load error:', e); reject(e); },
      }).connect(this.reverb);
    });

    await Promise.all([pianoLoad, celloLoad]);

    this.loading = false;
    this._init = true;
  }

  /* ── Public setters ─────────────────────────────────── */

  setHeightProfile(p) { this.heightProfile = p; this._rebuild(); }
  setScale(s)         { this.scale = s;         this._rebuild(); }
  setScaleRoot(r)     { this.scaleRoot = r;     this._rebuild(); }
  setBaseOctave(o)    { this.baseOctave = o;    this._rebuild(); }
  setNoteCount(n)     { this.noteCount = n;     this._rebuild(); }
  setBassEnabled(v)   { this.bassEnabled = v; }

  // Accent info from color analysis — drives how present the strings are.
  // saturation: 0..1, warmth: -1..1 (unused for now but available).
  setAccentColor({ saturation = 0, warmth = 0 } = {}) {
    const s = Math.max(0, Math.min(1, saturation));
    this.stringsLevel = 0.3 + s * 0.7;   // 0.3 (minimal) → 1.0 (lush)
  }

  /*
   * Map scalar image metrics to per-note perturbation probabilities.
   * Eno-style generative: the piano melody itself skips, echoes, or grows
   * a harmony note occasionally — variation emerges from the image's mood
   * rather than from an independent synth voice.
   *
   *   contrast         → overall activity (dramatic = more perturbations)
   *   brightness       → bias toward up-reaching ornaments vs. skips
   *   saturationSpread → ornament probability (vivid images get color tones)
   *   warmth           → bias toward major-3rd (warm) vs. minor-3rd (cool) harmony
   */
  setImageMetrics({ brightness = 0.5, contrast = 0.5, warmth = 0, saturationSpread = 0.3 } = {}) {
    const b = Math.max(0, Math.min(1, brightness));
    const c = Math.max(0, Math.min(1, contrast));
    const w = Math.max(-1, Math.min(1, warmth));
    const s = Math.max(0, Math.min(1, saturationSpread));

    // Contrast is the master "activity" dial. Brightness gently biases
    // type selection: bright images get more ornament/harmony, dark ones
    // get more skips (a kind of reverent silence).
    this.genParams.skip     = 0.015 + (1 - b) * 0.025 + c * 0.02;   // 1.5%..6%
    this.genParams.harmony  = 0.04  + c * 0.07 + b * 0.02;           // 4%..13%
    this.genParams.echo     = 0.03  + c * 0.05;                      // 3%..8%
    this.genParams.ornament = 0.02  + s * 0.08 + b * 0.02;           // 2%..12%
    this.genParams.warmth   = w;
  }

  // Pedal toggle — lengthens piano release & note duration. Meant as a
  // temporary exploration control per the Phase-2 spec.
  setPedalEnabled(v) {
    this.pedalEnabled = !!v;
    if (this.piano) {
      this.piano.release = v ? 6.0 : 3.2;
    }
  }

  setGenerativeEnabled(v) { this.generativeEnabled = !!v; }

  setBpm(b) {
    this.bpm = b;
    if (this._init) Tone.Transport.bpm.value = b;
  }

  setVolume(v) {
    if (this.piano) {
      const db = v <= 0 ? -Infinity : 20 * Math.log10(v) - 6;
      this.piano.volume.value = db;
    }
    if (this.strings) {
      // Strings track the piano master volume but sit ~8 dB lower
      const db = v <= 0 ? -Infinity : 20 * Math.log10(v) - 14;
      this.strings.volume.value = db;
    }
  }

  _rebuild() {
    this._buildNotes();
    this._buildChords();
  }

  /* ── Build note sequence from height profile ────────── */

  _buildNotes() {
    if (!this.heightProfile) return;

    const sampled = SilhouetteExtractor.downsample(this.heightProfile, this.noteCount);
    const intervals = MusicEngine.SCALES[this.scale] || MusicEngine.SCALES.pentatonic;

    // Build note table across ~2 octaves centered on baseOctave. A narrower
    // range keeps the silhouette-mapped melody within reach of a single staff
    // on the UI side — 4 octaves spans so much ledger-line territory that low
    // valleys and high peaks get clipped off the score canvas. 2 octaves plus
    // the fractional head/tail is plenty for dynamic-feeling melodies.
    const rootPc = MusicEngine.NOTE_NAMES.indexOf(this.scaleRoot);
    const table = [];          // [{ name, midi }]
    const octStart = Math.max(1, this.baseOctave);
    const octEnd   = Math.min(7, this.baseOctave + 1);
    for (let oct = octStart; oct <= octEnd; oct++) {
      for (const iv of intervals) {
        const pc = (rootPc + iv) % 12;
        const name = MusicEngine.NOTE_NAMES[pc] + oct;
        const midi = 12 * (oct + 1) + pc;
        if (midi >= 24 && midi <= 96) table.push({ name, midi });
      }
    }

    this.notes = [];
    this.velocityProfile = [];
    let prevH = sampled[0];
    // Squeeze the silhouette-height → pitch mapping into the middle 70% of
    // the note table. Extreme heights (0 and 1) won't jump to the very top /
    // bottom of the range, which keeps notes comfortably inside staff ledger
    // territory even on dramatic silhouettes like a tall mountain peak.
    const PITCH_SQUEEZE = 0.7;
    const pitchSlack = (1 - PITCH_SQUEEZE) / 2;
    for (let i = 0; i < sampled.length; i++) {
      const h = Math.max(0, Math.min(1, sampled[i]));
      const mapped = pitchSlack + h * PITCH_SQUEEZE;
      const idx = Math.floor(mapped * (table.length - 1));
      this.notes.push(table[idx]);

      // Velocity: bigger jumps in silhouette = harder strike.
      // Flat stretches sit at ~0.45, steep peaks reach ~0.92.
      const slope = Math.abs(h - prevH);
      const normSlope = Math.min(1, slope / 0.18);
      this.velocityProfile.push(0.48 + normSlope * 0.44);
      prevH = h;
    }
  }

  /* ── Build chord progression for the strings bed ─────── */
  /*
   * Each 8-note bar picks a chord degree from the full scale using the
   * bar's avg silhouette height — but RELATIVE to the piece's own mean +
   * range, so a uniform-height image (e.g. a distant mountain) still
   * differentiates its bars musically instead of collapsing to one chord.
   *
   * A secondary per-bar "lift" nudges the degree by ±1 based on the bar's
   * trend (rising → up a step, falling → down a step). And we avoid
   * repeating the same degree twice in a row — when the algorithm wants
   * a repeat, it swaps to a harmonic neighbor (closest-tone substitution).
   */
  _buildChords() {
    this.chords = [];
    this.chordDegrees = [];
    this.chordNames = [];
    if (!this.heightProfile) return;

    const sampled   = SilhouetteExtractor.downsample(this.heightProfile, this.noteCount);
    const intervals = MusicEngine.SCALES[this.scale] || MusicEngine.SCALES.pentatonic;
    const n = intervals.length;
    const rootPc = MusicEngine.NOTE_NAMES.indexOf(this.scaleRoot);
    const chordOct = Math.max(2, Math.min(4, this.baseOctave - 1));

    const midiToName = (m) =>
      MusicEngine.NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

    const barSize = 8;
    const numBars = Math.ceil(sampled.length / barSize);

    // Map chord scale-degree → roman numeral display label
    const ROMAN_MAJORISH = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
    const ROMAN_MINORISH = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];
    const useMinor = (this.scale === 'minor' || this.scale === 'phrygian' || this.scale === 'dorian');
    const ROMAN = useMinor ? ROMAN_MINORISH : ROMAN_MAJORISH;

    // First pass: compute each bar's avg & slope
    const barStats = [];
    for (let bar = 0; bar < numBars; bar++) {
      const start = bar * barSize;
      const end   = Math.min(start + barSize, sampled.length);
      let avgH = 0;
      for (let i = start; i < end; i++) avgH += sampled[i];
      avgH /= (end - start);
      const slope = (sampled[end - 1] - sampled[start]); // + rising, − falling
      barStats.push({ avgH, slope });
    }

    // Normalize bar avgs to their own distribution so a flat silhouette
    // still gets spread across the full set of chords.
    const avgs = barStats.map(b => b.avgH);
    const minA = Math.min(...avgs);
    const maxA = Math.max(...avgs);
    const rangeA = Math.max(1e-3, maxA - minA);

    // Preferred degree pool by scale length. For 7-note modes we use all
    // degrees; for pentatonic the 5 scale degrees naturally span I–vi.
    const degreePool = Array.from({ length: Math.min(n, 7) }, (_, i) => i);
    const poolLen = degreePool.length;

    let prevDegree = -1;
    for (let bar = 0; bar < numBars; bar++) {
      const { avgH, slope } = barStats[bar];
      // Map the bar's *relative* avg position → degree index
      const rel = (avgH - minA) / rangeA;       // 0..1 within this image
      let k = Math.round(rel * (poolLen - 1));
      // Trend-based lift: steep rise/fall nudges one step either way
      if (slope > 0.12) k = Math.min(poolLen - 1, k + 1);
      else if (slope < -0.12) k = Math.max(0, k - 1);

      // Avoid immediate repeats — sub to a harmonic neighbor (±1 step)
      if (k === prevDegree && poolLen > 1) {
        k = (k + (Math.random() < 0.5 ? 1 : -1) + poolLen) % poolLen;
      }
      prevDegree = k;
      k = Math.min(k, n - 1);

      // Scale-relative intervals from the chord root
      const thirdOff = (intervals[(k + 2) % n] - intervals[k] + 12) % 12;
      const fifthOff = (intervals[(k + 4) % n] - intervals[k] + 12) % 12;
      const rootMidi = 12 * (chordOct + 1) + (rootPc + intervals[k]) % 12;

      // Voicing: root (low) + fifth + octave-root + third (high)
      const voicing = [
        midiToName(rootMidi),
        midiToName(rootMidi + fifthOff),
        midiToName(rootMidi + 12),
        midiToName(rootMidi + thirdOff + 12),
      ];
      this.chords.push(voicing);
      // Per-bar roman numeral for the chord-strip UI
      this.chordDegrees.push(ROMAN[Math.min(k, ROMAN.length - 1)]);
      // Per-bar display chord name (e.g. "F#m"). Pretty names with Unicode ♯.
      const rootDisplay = MusicEngine.NOTE_NAMES[(rootPc + intervals[k]) % 12].replace('#', '\u266F');
      const quality = thirdOff === 3 ? 'm' : (thirdOff === 4 ? '' : (thirdOff === 2 ? 'sus2' : ''));
      this.chordNames.push(rootDisplay + quality);
    }
  }

  /*
   * Given a note name like "F#4" and an integer scale-step offset, return
   * the corresponding in-scale note. Used by the generative layer to build
   * harmonies and ornaments that stay diatonic.
   */
  _scaleStep(noteName, steps) {
    const m = noteName && noteName.match(/^([A-G]#?)(\d+)$/);
    if (!m) return null;
    const NOTE_NAMES = MusicEngine.NOTE_NAMES;
    const intervals = MusicEngine.SCALES[this.scale] || MusicEngine.SCALES.pentatonic;
    const pc = NOTE_NAMES.indexOf(m[1]);
    const oct = parseInt(m[2]);
    const rootPc = NOTE_NAMES.indexOf(this.scaleRoot);
    const relPc = (pc - rootPc + 12) % 12;

    // Find the note's index in the scale (snap to nearest if off-scale)
    let scaleIdx = intervals.indexOf(relPc);
    if (scaleIdx < 0) {
      let best = 0, bestDiff = 12;
      for (let i = 0; i < intervals.length; i++) {
        const d = Math.min(
          Math.abs(intervals[i] - relPc),
          12 - Math.abs(intervals[i] - relPc)
        );
        if (d < bestDiff) { bestDiff = d; best = i; }
      }
      scaleIdx = best;
    }
    const n = intervals.length;
    const newIdx = scaleIdx + steps;
    const octShift = Math.floor(newIdx / n);
    const newInterval = intervals[((newIdx % n) + n) % n];
    const newOct = oct + octShift;
    const newPc = (rootPc + newInterval) % 12;
    if (newOct < 1 || newOct > 7) return null;
    return NOTE_NAMES[newPc] + newOct;
  }

  /*
   * For a given step i + its note, decide if this beat gets skipped, gets
   * a harmony laid on top, echoes softly later, or grows an ornament after.
   * Returns { skip, extras: [{ note, dur, delay, vel }] }. Each perturbation
   * is an independent roll — usually at most one fires per step.
   *
   * Beat 0 of every bar is protected (never skipped) so the pulse stays
   * legible. Echoes and ornaments land inside the same quarter-note window
   * so they don't bleed into the next step.
   */
  _generativePerturbations(i, n, vel) {
    const g = this.genParams;
    const extras = [];
    let skip = false;
    if (!this.generativeEnabled || !n) return { skip, extras };

    // Skip (silences this note). Protected: bar-starts and the final note.
    if (i % 8 !== 0 && i < this.notes.length - 1 && Math.random() < g.skip) {
      skip = true;
      return { skip, extras };   // nothing else stacks on a skipped note
    }

    // Harmony — an in-scale 3rd above, softer than the melody
    if (Math.random() < g.harmony) {
      const harmony = this._scaleStep(n.name, 2); // two scale-steps ≈ a 3rd
      if (harmony) extras.push({ note: harmony, dur: '2n', delay: 0, vel: vel * 0.45 });
    }

    // Echo — same pitch, quieter, a beat later
    if (Math.random() < g.echo) {
      extras.push({ note: n.name, dur: '4n', delay: 0.28, vel: vel * 0.32 });
    }

    // Ornament — quick upper-neighbor grace note immediately after
    if (Math.random() < g.ornament) {
      const up = this._scaleStep(n.name, 1);
      if (up) extras.push({ note: up, dur: '16n', delay: 0.11, vel: vel * 0.40 });
    }

    return { skip, extras };
  }


  /* ── Playback ───────────────────────────────────────── */

  async play() {
    if (!this._init) await this.init();
    if (!this.notes.length) return;

    if (this.isPaused) {
      this.isPaused = false;
      Tone.Transport.start();
      this.isPlaying = true;
      return;
    }

    this.stop();
    this.isPlaying = true;
    this.currentIndex = 0;
    this.currentChordBar = -1;
    Tone.Transport.bpm.value = this.bpm;

    const barSize = 8;

    this.scheduledId = Tone.Transport.scheduleRepeat((time) => {
      if (this.currentIndex >= this.notes.length) {
        if (this.loop) {
          this.currentIndex = 0;
          this.currentChordBar = -1; // retrigger strings on loop
        } else {
          this.stop();
          return;
        }
      }

      const i = this.currentIndex;
      const n = this.notes[i];

      // Micro timing humanization (±15ms). Keeps the grid from sounding mechanical.
      const jitter = (Math.random() - 0.5) * 0.03;
      const tNote = time + jitter;

      // Velocity from silhouette slope (expressive dynamics)
      const vel = this.velocityProfile[i] ?? 0.7;

      // Pedal mode stretches note duration so they bleed into each other
      const melodyDur = this.pedalEnabled ? '1m' : '2n';

      // Eno-style generative: this note may be skipped, doubled with a
      // harmony, echoed, or ornamented. Probabilities come from the image.
      const perturb = this._generativePerturbations(i, n, vel);
      if (!perturb.skip) {
        try {
          this.piano.triggerAttackRelease(n.name, melodyDur, tNote, vel);
        } catch (_) {}
      }
      for (const ex of perturb.extras) {
        try {
          this.piano.triggerAttackRelease(ex.note, ex.dur, tNote + ex.delay, ex.vel);
        } catch (_) {}
      }
      // Surface perturbations to the UI (for the orange marker dots).
      // Only fires when something non-default happened — quiet notes
      // don't spam the callback.
      if ((perturb.skip || perturb.extras.length) && this.onNotePerturb) {
        // Categorize kinds that fired for richer visualization
        const kinds = [];
        if (perturb.skip) kinds.push('skip');
        for (const ex of perturb.extras) {
          // Recover kind from the shape of the extra
          if (ex.dur === '16n') kinds.push('ornament');
          else if (ex.delay > 0) kinds.push('echo');
          else kinds.push('harmony');
        }
        this.onNotePerturb(i, { skip: perturb.skip, kinds });
      }

      // Strings bed: trigger on bar boundary, held 2 bars so they overlap
      // into the next — no audible seam at chord changes.
      const bar = Math.floor(i / barSize);
      if (bar !== this.currentChordBar && this.chords[bar] && this.strings) {
        const barDur = (barSize * 60) / this.bpm; // seconds
        const chordVel = 0.42 * this.stringsLevel;
        try {
          this.strings.triggerAttackRelease(this.chords[bar], barDur * 2.0, tNote, chordVel);
        } catch (_) {}
        this.currentChordBar = bar;
        if (this.onChordBar) this.onChordBar(bar);
      }

      // Piano chord every OTHER bar (flat-stretch anchor). Soft broken chord
      // sitting one octave above the cello voicing, so it blooms under the
      // melody without fighting the low register.
      if (i % barSize === 0 && bar % 2 === 0 && this.chords[bar] && this.piano) {
        const voicing = this.chords[bar];
        const shiftUp = (nm) => {
          const m = nm.match(/^([A-G]#?)(\d+)$/);
          if (!m) return nm;
          return m[1] + (parseInt(m[2]) + 1);
        };
        // Arpeggiate with ~40ms stagger — feels like a hand rolling a chord
        for (let j = 0; j < voicing.length; j++) {
          const tJ = tNote + j * 0.04;
          const velJ = 0.28 * vel;
          try {
            this.piano.triggerAttackRelease(shiftUp(voicing[j]), '2n', tJ, velJ);
          } catch (_) {}
        }
      }

      // Bass: root of the current piano note, two octaves lower, every 4 steps
      if (this.bassEnabled && this.piano && i % 4 === 0) {
        const match = n.name.match(/^([A-G]#?)(\d+)$/);
        if (match) {
          const bassOct = Math.max(1, parseInt(match[2]) - 2);
          try { this.piano.triggerAttackRelease(match[1] + bassOct, '1m', tNote, 0.42); } catch (_) {}
        }
      }

      if (this.onNotePlay) this.onNotePlay(i);
      if (this.onChordPlay) this.onChordPlay([n.name]);

      this.currentIndex++;
    }, '4n');

    Tone.Transport.start();
  }

  pause() {
    if (!this.isPlaying) return;
    Tone.Transport.pause();
    this.isPaused = true;
    this.isPlaying = false;
  }

  stop() {
    Tone.Transport.stop();
    Tone.Transport.cancel();
    if (this.strings) { try { this.strings.releaseAll(); } catch (_) {} }
    if (this.piano)   { try { this.piano.releaseAll();   } catch (_) {} }
    this.isPlaying = false;
    this.isPaused = false;
    this.currentIndex = 0;
    this.currentChordBar = -1;
    this.scheduledId = null;
  }
}
