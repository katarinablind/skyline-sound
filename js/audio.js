/**
 * Ambient polyphonic music engine.
 *
 * Warm sine-based instruments with long envelopes create
 * overlapping, legato textures. Each chord rings out over
 * a dotted whole note while new chords fade in underneath,
 * producing a cohesive ambient wash.
 */

class MusicEngine {
  constructor() {
    this.synth = null;
    this.reverb = null;
    this.delay = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.loop = true;
    this.bpm = 180;
    this.noteCount = 48;
    this.scale = 'pentatonic';
    this.instrumentName = 'pad';
    this.heightProfile = null;
    this.notes = [];
    this.currentIndex = 0;
    this.scheduledId = null;
    this.onNotePlay = null;
    this._init = false;
  }

  /* ── Scales ──────────────────────────────────────────── */

  static SCALES = {
    pentatonic: [0, 2, 4, 7, 9],
    major:      [0, 2, 4, 5, 7, 9, 11],
    minor:      [0, 2, 3, 5, 7, 8, 10],
    blues:      [0, 3, 5, 6, 7, 10],
  };

  static NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  /* ── Warm ambient instrument presets ────────────────── */

  static INSTRUMENTS = {
    pad: {
      create() {
        return new Tone.PolySynth(Tone.AMSynth, {
          maxPolyphony: 16,
          options: {
            harmonicity: 2,
            oscillator: { type: 'sine' },
            envelope:    { attack: 3.0, decay: 2.0, sustain: 0.85, release: 6.0 },
            modulation:  { type: 'sine' },
            modulationEnvelope: { attack: 3.5, decay: 1.5, sustain: 0.5, release: 4 },
          },
          volume: -16,
        });
      },
    },
    marimba: {
      create() {
        return new Tone.PolySynth(Tone.AMSynth, {
          maxPolyphony: 16,
          options: {
            harmonicity: 3,
            oscillator: { type: 'sine' },
            envelope:    { attack: 0.8, decay: 3.0, sustain: 0.15, release: 5.0 },
            modulation:  { type: 'sine' },
            modulationEnvelope: { attack: 1.5, decay: 2, sustain: 0.2, release: 3 },
          },
          volume: -12,
        });
      },
    },
    bowl: {
      create() {
        return new Tone.PolySynth(Tone.FMSynth, {
          maxPolyphony: 12,
          options: {
            harmonicity: 3.01,
            modulationIndex: 0.3,
            oscillator: { type: 'sine' },
            envelope:    { attack: 2.5, decay: 3, sustain: 0.6, release: 7 },
            modulation:  { type: 'sine' },
            modulationEnvelope: { attack: 3, decay: 2, sustain: 0.3, release: 5 },
          },
          volume: -14,
        });
      },
    },
    glass: {
      create() {
        return new Tone.PolySynth(Tone.AMSynth, {
          maxPolyphony: 16,
          options: {
            harmonicity: 4,
            oscillator: { type: 'sine' },
            envelope:    { attack: 2.0, decay: 3, sustain: 0.3, release: 6 },
            modulation:  { type: 'sine' },
            modulationEnvelope: { attack: 2.5, decay: 1.5, sustain: 0.2, release: 4 },
          },
          volume: -12,
        });
      },
    },
    drone: {
      create() {
        return new Tone.PolySynth(Tone.AMSynth, {
          maxPolyphony: 12,
          options: {
            harmonicity: 1.5,
            oscillator: { type: 'sine' },
            envelope:    { attack: 5, decay: 3, sustain: 0.9, release: 8 },
            modulation:  { type: 'sine' },
            modulationEnvelope: { attack: 6, decay: 3, sustain: 0.7, release: 6 },
          },
          volume: -20,
        });
      },
    },
  };

  /* ── Init (requires user gesture) ───────────────────── */

  async init() {
    if (this._init) return;
    await Tone.start();

    this.reverb = new Tone.Reverb({ decay: 9, wet: 0.55 }).toDestination();
    await this.reverb.generate();

    this.delay = new Tone.FeedbackDelay({
      delayTime: '4n.', feedback: 0.22, wet: 0.14,
    });
    this.delay.connect(this.reverb);

    this._createSynth();
    this._init = true;
  }

  _createSynth() {
    if (this.synth) { this.synth.disconnect(); this.synth.dispose(); }
    this.synth = MusicEngine.INSTRUMENTS[this.instrumentName].create();
    this.synth.connect(this.delay);
  }

  /* ── Public setters ─────────────────────────────────── */

  setInstrument(name) {
    if (!MusicEngine.INSTRUMENTS[name]) return;
    this.instrumentName = name;
    if (this._init) this._createSynth();
  }

  setHeightProfile(p) { this.heightProfile = p; this._buildNotes(); }
  setScale(s)         { this.scale = s;         this._buildNotes(); }
  setNoteCount(n)     { this.noteCount = n;     this._buildNotes(); }

  setBpm(b) {
    this.bpm = b;
    if (this._init) Tone.Transport.bpm.value = b;
  }

  setVolume(v) {
    // v is 0→1
    if (this.synth) {
      const db = v <= 0 ? -Infinity : 20 * Math.log10(v) - 6;
      this.synth.volume.value = db;
    }
  }

  /* ── Build chord sequence from height profile ───────── */

  _buildNotes() {
    if (!this.heightProfile) return;

    const sampled = SilhouetteExtractor.downsample(this.heightProfile, this.noteCount);
    const intervals = MusicEngine.SCALES[this.scale] || MusicEngine.SCALES.pentatonic;

    // Build note table C2 → C6
    const table = [];
    for (let oct = 2; oct <= 6; oct++) {
      for (const iv of intervals) {
        const midi = 12 * (oct + 1) + iv;
        if (midi > 96) break;
        table.push(MusicEngine.NOTES[iv % 12] + oct);
      }
    }

    this.notes = [];
    for (let i = 0; i < sampled.length; i++) {
      const h = Math.max(0, Math.min(1, sampled[i]));
      const idx = Math.floor(h * (table.length - 1));

      // Simpler voicing: root + a wider interval (fifth-ish)
      const chord = [table[idx]];
      if (idx + 4 < table.length) chord.push(table[idx + 4]);

      // Every 6th note gets a third voice for subtle richness
      if (i % 6 === 0 && idx + 7 < table.length) chord.push(table[idx + 7]);

      this.notes.push(chord);
    }
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
    Tone.Transport.bpm.value = this.bpm;

    this.scheduledId = Tone.Transport.scheduleRepeat((time) => {
      if (this.currentIndex >= this.notes.length) {
        if (this.loop) {
          this.currentIndex = 0;
        } else {
          this.stop();
          return;
        }
      }

      const chord = this.notes[this.currentIndex];
      // Dotted whole note — massive overlap for legato blend
      try { this.synth.triggerAttackRelease(chord, '1n.', time); } catch (_) {}

      const idx = this.currentIndex;
      Tone.Draw.schedule(() => { if (this.onNotePlay) this.onNotePlay(idx); }, time);

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
    this.isPlaying = false;
    this.isPaused = false;
    this.currentIndex = 0;
    this.scheduledId = null;
  }
}
