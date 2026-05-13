# SkylineSound — Data Mapping Reference

How an image becomes music, one transform at a time, and how to lift each
transform into its own isolated playground in the `media-pipe` style.

---

## Part 1 — Current mappings (what ships)

The pipeline is a chain of small, independent transforms. Each has a
clear input/output contract, a handful of tuning constants, and a
design rationale you can argue about without touching any of the others.

```
┌──────────┐   silhouette    ┌──────────┐   notes    ┌──────┐
│  image   │───────────────▶│  engine  │──────────▶│ audio │
│ (canvas) │   palette       │          │   chords   │      │
│          │───────────────▶│ music    │──────────▶│      │
│          │   dominant      │ params   │  rubato    │      │
│          │───────────────▶│          │──────────▶│      │
│          │   metrics       │          │            │      │
│          │───────────────▶│          │            │      │
└──────────┘                 └──────────┘            └──────┘
```

Part 1 is organized in three stages:

| Stage | IDs | Question |
|---|---|---|
| **1a** Image → musical parameters | M1–M9 | "What does this image *mean* musically?" |
| **1b** Musical parameters → notes, chords | M10–M17 | "What does that mean actually play?" |
| **1c** Arrangement & rubato | M18–M19 | "How do the layers sit together?" |

---

## Part 1a — Image → musical parameters

### M1 · Image → Silhouette *(horizon trace)*

**In** canvas `W×H` RGBA pixels
**Out** `Float32Array(W)` of normalized y-values `[0, 1]` where `1` = top
**Owner** `js/silhouette.js` → `SilhouetteExtractor.extract(canvas)`

Three progressive algorithms behind one dispatcher
(`window.__skylineDetectMode`, default `v3`):

| Version | Strategy | Breaks on |
|---|---|---|
| **v1** | Sky-region growing — start at top of each column, grow down while brightness changes gradually. Break on abrupt step. | Overcast skies (no sky/ground contrast). Foreground trees. |
| **v2** | Pre-blur → Sobel gradient → per-column topmost strong edge with continuity constraint to last column. | Jagged city skylines (picks one building, jumps to another). |
| **v3** | Dynamic programming shortest-path over the gradient map (seam-carving idea). Cost = `(1 − g/maxG) + α·(y/h) + β·aboveFrac + skyPenalty`. Max dy per column = 2 so the path stays continuous. | Very smooth gradients where real horizon blends with distant hills. |

**Key constants (v3)** — `alpha = 0.08` (mild top-bias), `beta = 0.55`
(penalty for gradient already seen above in that column),
`skyPenalty = 0.15`. Tuning these is the whole game. The `beta` term
was added specifically to fix the city regression where DP preferred
smooth distant ridges over jagged buildings.

**Post-processing** — median filter (r=3) → outlier-dip removal
(radius=40, threshold=0.04, 3 passes) → weighted multi-pass smoothing
(half-width=10).

**Override path** — if `assets/overrides/<sampleId>.override.json`
exists for a baked sample, the detection result is replaced wholesale
by the hand-tuned array (resampled to current canvas width if needed).
Used today for `mountains` only.

---

### M2 · Image → Dominant color *(for tonal key)*

**In** canvas pixels
**Out** single weighted-average `{r, g, b, h, s, l}`
**Owner** `colorAnalysis.js` → `extractDominants(canvas, k=3)` + weighted mean

Raw top-3 buckets by pixel count. **No vibrance weighting** — this
one is deliberately "what colors dominate the pixels," because it
drives the key signature, and the key should follow the image's
overall mood, not its most eye-catching accent.

- Grid sample at stride `w/60 × h/60`
- Bucket into 4096 cells (4 bits/channel: `((r>>4)<<8) | ((g>>4)<<4) | (b>>4)`)
- Take top 3 by count, weight-average their RGB, convert to HSL

---

### M3 · Image → Palette *(display swatches, 5 colors)*

**In** canvas pixels
**Out** 5 swatch colors, sorted by lightness descending
**Owner** `colorAnalysis.js` → `extractPalette(canvas, k=5)`

This is the "**dominant ≠ most frequent**" algorithm — two-pass
greedy selection with diversity constraint.

- **Score** each bucket: `score = 0.55·(count/maxCount) + 0.45·(vibrance/maxVib)`
- **Vibrance** = `count · max(0, s − 0.12) · (0.3 + midLight · 0.7)`
  (so near-black and near-white don't steal slots, and desaturation
  under 0.12 is ignored as noise)
- **Pass 1** — walk by score desc, accept only if RGB-Euclidean
  distance from every already-picked swatch ≥ **MIN_DIST = 45**
- **Pass 2** (fallback) — if still <5 picks, relax distance to
  `0.55 × MIN_DIST` and walk by pure vibrance

The `MIN_DIST = 45` threshold prevents the common failure where a
forest shot yields four near-identical dark greens. Raise it and
monochrome images can't fill 5 swatches; lower it and you get the
four-near-blacks problem. **45 is the whole design.**

---

### M4 · Hue → Mode

**In** `h ∈ [0, 360)`, `s ∈ [0, 1]`
**Out** one of `pentatonic | lydian | mixolydian | major | dorian | minor | phrygian`
**Owner** `colorAnalysis.js` → `hueToMode(h, s)`

Fuzzy-bucket table (edges inclusive on the low end):

| Hue range | Mode | Feel |
|---|---|---|
| `s < 0.15` (any hue) | pentatonic | mode-ambiguous, desaturated |
| `[0, 20)` | lydian | warm, bright |
| `[20, 50)` | mixolydian | orange, bluesy-major |
| `[50, 80)` | major | yellow, radiant |
| `[80, 160)` | dorian | green, balanced |
| `[160, 200)` | mixolydian | cyan |
| `[200, 260)` | minor | blue, introspective |
| `[260, 310)` | phrygian | purple, dark |
| `[310, 360)` | lydian | magenta → back to warm |

Hard bucket boundaries — no interpolation between adjacent modes.
Saturation gate (`< 0.15 → pentatonic`) is the single escape hatch
for grey-dominated images.

`blues` is defined in the scale table (M17) but not referenced by
M4 — it's available for future mappings (e.g. a "jazz mode" when
hue ≈ brown/sepia).

---

### M5 · Hue → Root

**In** `h ∈ [0, 360)`
**Out** pitch class name (`C`, `C#`, …, `B`)
**Owner** `colorAnalysis.js` → `hueToRoot(h)`

Circle of fifths around the color wheel:

```js
['C','G','D','A','E','B','F#','C#','G#','D#','A#','F']
idx = floor(h / 360 * 12) % 12
```

Warm colors (red/orange/yellow) cluster around C/G/D. Cool colors
(blue/purple) land on F#/C#/G#. No saturation gate — even grey
images need a root.

---

### M6 · Lightness → Octave

**In** `l ∈ [0, 1]`
**Out** integer octave `3 | 4 | 5`
**Owner** `colorAnalysis.js` → `lightnessToOctave(l)`

Hard thresholds:

```
l < 0.25        → 3    (dark image → low register)
0.25 ≤ l < 0.55 → 4    (mid → middle)
l ≥ 0.55        → 5    (bright → high)
```

Only 3 buckets because the silhouette-to-pitch mapping already
spans about 2 octaves — giving it a 5-octave base would push notes
off the staff in either direction.

---

### M7 · Warmth → BPM

**In** average `r, g, b` of the dominant blend
**Out** integer BPM, range `[60, 76]`
**Owner** `colorAnalysis.js` → `warmthToBpm(r, g, b)`

Linear:

```
warmth = (r − b) / 255     // −1 (very cool) to +1 (very warm)
bpm = round(68 + warmth · 8)
```

68 BPM is the neutral anchor (mid-Adagio, ~Debussy's *Clair de Lune*).
±8 BPM range is deliberately narrow — bigger swings break the piano
piece's sense of a single composition.

---

### M8 · Image → Scalar metrics *(for rubato layer)*

**In** canvas pixels
**Out** `{ brightness, contrast, saturationSpread }` — each in `[0, 1]`
**Owner** `colorAnalysis.js` → `_extractImageMetrics(canvas)`

One pass at 80×80 sample grid. For each sample, compute HSL.

```
brightness       = mean(l)
contrast         = min(1, std(l) × 3.2)
saturationSpread = min(1, std(s) × 3.2)
```

The `× 3.2` multiplier is the "typical photograph hits mid-range"
calibration — normal photos land around 0.3 – 0.6 on both metrics.
These feed the rubato layer (M13), not the score.

---

### M9 · Palette → Accent metrics

**In** the 5-color palette from M3
**Out** `{ accentSaturation ∈ [0,1], accentWarmth ∈ [−1,1] }`
**Owner** `colorAnalysis.js` → inline in `analyze()`

```
colorful = palette filter (s > 0.2) sort by s desc take 2
accentSaturation = mean(colorful.s)
accentWarmth     = mean((r − b) / 255) over colorful
```

Drives the string bed's presence via M12.
`accentWarmth` is computed but not currently consumed by the engine.

---

## Part 1b — Musical parameters → notes & chords

### M10 · Silhouette → Melody notes

**In** `heightProfile` (any length), `noteCount` (16–64), `scale`, `root`, `octave`
**Out** `notes[]` of `{ name, midi }` length `noteCount`, plus `velocityProfile`
**Owner** `audio.js` → `MusicEngine._buildNotes()`

1. **Downsample** `heightProfile` to exactly `noteCount` points
2. Build **note table** — all scale-degree notes across 2 octaves
   from `octStart = baseOctave` to `octEnd = baseOctave + 1`
3. **Pitch mapping** — `h ∈ [0, 1]` squeezed into middle 70 % of the
   table to keep notes inside ledger territory:
   ```
   PITCH_SQUEEZE = 0.7
   mapped = (1 − 0.7)/2 + h · 0.7       // → [0.15, 0.85]
   idx = floor(mapped · (table.length − 1))
   ```
4. **Velocity** — `velocity[i] = 0.48 + min(1, |h[i]−h[i-1]| / 0.18) · 0.44`
   (flat stretches ~0.45, steep slopes up to ~0.92)

The `0.18` slope normalizer is the "typical image gradient" prior —
anything steeper than 0.18 height units per step counts as "hard strike."

---

### M11 · Silhouette → Bar-level chord degrees

**In** `heightProfile`, `noteCount`, `barSize = 8`
**Out** one chord-degree index `k` per bar (inputs to M15)
**Owner** `audio.js` → `MusicEngine._buildChords()` first pass

Two stacked rules that shape how chords move between bars:

**Rule A — per-piece normalization:**

```
rel = (barAvg − minBarAvg) / (maxBarAvg − minBarAvg)    // 0..1
k = round(rel · (poolLen − 1))
```

A nearly-flat silhouette still gets its full chord range — bars are
relative to *this* piece, not absolute image values.

**Rule B — trend lift (±1 step):**

```
if bar.slope >  0.12: k = min(poolLen−1, k + 1)   // rising → lifts one degree
if bar.slope < -0.12: k = max(0, k − 1)            // falling → drops one
```

The `0.12` threshold is the "visibly tilted" cutoff — gentle slopes
don't trigger, only bars with a clear rise or fall.

**Rule C — repeat avoidance:**

```
if k == prevDegree and poolLen > 1:
    k = (k ± 1 + poolLen) % poolLen     // random ±1 harmonic neighbor
```

Prevents locking into a single chord for multiple bars.

---

### M12 · Accent saturation → Strings level

**In** `accentSaturation ∈ [0, 1]` (from M9)
**Out** `stringsLevel ∈ [0.3, 1.0]` — scalar gain on the cello bed
**Owner** `audio.js` → `MusicEngine.setAccentColor({ saturation })`

```
stringsLevel = 0.3 + saturation · 0.7
```

The single knob that says "how present should the chord bed be?"
Desaturated images (a foggy lake) get `0.3` — strings are a warm
halo under the piano. Vivid images (a sunset sky) approach `1.0` —
a lush bed that's almost equal weight with the piano.

The `0.3` floor is deliberate — even a monochrome image should have
*some* harmonic support, otherwise the piano-only result sounds naked.

---

### M13 · Image metrics → Generative probabilities

**In** `{ brightness b, contrast c, warmth w, saturationSpread s }`
**Out** `{ skip, harmony, echo, ornament }` — per-note probabilities
**Owner** `audio.js` → `MusicEngine.setImageMetrics(...)`

Where the image's *mood* modulates the piano's *personality*.

| Probability | Formula | Range | Driven by |
|---|---|---|---|
| **skip** | `0.015 + (1−b)·0.025 + c·0.02` | 1.5 % – 6 % | Dark + dramatic → more skips (reverent silence) |
| **harmony** | `0.04 + c·0.07 + b·0.02` | 4 % – 13 % | Dramatic + bright → more 3rds layered on |
| **echo** | `0.03 + c·0.05` | 3 % – 8 % | Dramatic → more spatial ghosting |
| **ornament** | `0.02 + s·0.08 + b·0.02` | 2 % – 12 % | Vivid + bright → more upper-neighbor grace notes |

**Master dial** — `contrast` is the overall activity scalar; it
shows up in three of four formulas. High-contrast images (storm
clouds, sharp sunsets) feel more alive than low-contrast ones
(fog, midday haze).

**Temperament** — `brightness` tilts the distribution. Dark +
dramatic = more skips (awe, restraint). Bright + dramatic = more
harmony and ornament (exuberance). Same contrast value, different
color of aliveness.

**Total perturbation budget** across all four rolls is roughly
10 – 40 % depending on image. Each is an independent Bernoulli trial
per note, so two of the four can fire on the same beat (e.g. a
harmony *and* an echo).

`warmth` is stored on `genParams.warmth` and intended to bias
harmony quality (major vs minor 3rd) but isn't currently consumed
in `_generativePerturbations` — left as a forward-compat hook.

---

### M14 · Scale → Roman-numeral flavor

**In** scale name (`minor | phrygian | dorian | ...`)
**Out** whether chord labels display as `I II III` or `i ii iii`
**Owner** `audio.js` → `MusicEngine._buildChords()` inline switch

```
useMinor = scale ∈ { minor, phrygian, dorian }
ROMAN = useMinor ? ['i','ii','iii','iv','v','vi','vii']
                 : ['I','II','III','IV','V','VI','VII']
```

Purely a display choice — Dorian's minor-ish first degree is
conventionally labeled `i` even though Dorian isn't strictly
"minor." The grouping matches what a trained ear would call "the
darker modes."

---

### M15 · Chord degree → 4-note voicing

**In** `k ∈ [0, poolLen)` — scale-degree index from M11
**Out** 4-note voicing as `[name, name, name, name]` low → high
**Owner** `audio.js` → `MusicEngine._buildChords()` voicing block

```
rootMidi  = 12·(chordOct+1) + (rootPc + intervals[k]) % 12
thirdOff  = (intervals[(k+2) % n] − intervals[k]) mod 12    // 3 or 4 semitones
fifthOff  = (intervals[(k+4) % n] − intervals[k]) mod 12    // ~7 semitones
voicing = [ root,
            root + fifthOff,
            root + 12,               // octave of root
            root + thirdOff + 12 ]   // third bumped up an octave
```

**Voicing order is the signature choice** — third-on-top. The color
note (major vs minor) sits in the most audible position, so the ear
grabs the mode immediately even before the piano melody lands.

**Chord octave** — `chordOct = clamp(2, 4, baseOctave − 1)` — one
octave below the piano melody's base, so the strings sit *under*
rather than alongside.

Because the interval offsets are computed per scale, degrees
automatically get the right quality — e.g. in Aeolian, degree I is
a minor triad; in Lydian, degree IV is augmented-ish.

---

### M16 · Interval → Chord quality label

**In** `thirdOff ∈ {0 … 11}` — the actual third interval in semitones
**Out** suffix on the displayed chord name (`F#m`, `F#`, `F#sus2`)
**Owner** `audio.js` → `MusicEngine._buildChords()` inline

```
quality = thirdOff === 3 ? 'm'        // minor 3rd above root
        : thirdOff === 4 ? ''          // major 3rd above root
        : thirdOff === 2 ? 'sus2'      // suspended (e.g. Dorian 2nd)
        :                   ''          // fallthrough → plain major label
```

Only these three surface today. Future: add `sus4`, `dim`, `aug`
when the corresponding intervals appear. Edge cases today (like
Lydian IV with a `#4` third) fall through to the plain label — a
known display bug.

---

### M17 · Scale library *(reference table, not a mapping per se)*

Eight scales defined in `MusicEngine.SCALES` as semitone-interval
sets from the root:

| Scale | Intervals | # notes | Hue bucket (M4) |
|---|---|---|---|
| **pentatonic** | `[0, 2, 4, 7, 9]` | 5 | fallback when `s < 0.15` |
| **major** (Ionian) | `[0, 2, 4, 5, 7, 9, 11]` | 7 | yellow `[50, 80)` |
| **minor** (Aeolian) | `[0, 2, 3, 5, 7, 8, 10]` | 7 | blue `[200, 260)` |
| **dorian** | `[0, 2, 3, 5, 7, 9, 10]` | 7 | green `[80, 160)` |
| **lydian** | `[0, 2, 4, 6, 7, 9, 11]` | 7 | red `[0, 20)`, magenta `[310, 360)` |
| **phrygian** | `[0, 1, 3, 5, 7, 8, 10]` | 7 | purple `[260, 310)` |
| **mixolydian** | `[0, 2, 4, 5, 7, 9, 10]` | 7 | orange `[20, 50)`, cyan `[160, 200)` |
| **blues** | `[0, 3, 5, 6, 7, 10]` | 6 | *unused* |

---

## Part 1c — Arrangement & rubato

### M18 · Rubato (probability → performance liberties)

**In** every scheduled note event, `genParams` from M13
**Out** same event, possibly perturbed
**Owner** `audio.js` → `MusicEngine._generativePerturbations()`

Independent Bernoulli rolls per note:

| Kind | Condition | Effect | Velocity | Timing offset | Duration |
|---|---|---|---|---|---|
| **skip** | `rand() < skip` AND not beat 0 of a bar AND not the final note | Don't play this note | — | — | — |
| **harmony** | `rand() < harmony` | Add in-scale 3rd above (2 scale-steps via `_scaleStep`) | `vel × 0.45` | simultaneous | `2n` |
| **echo** | `rand() < echo` | Same pitch repeated, softer | `vel × 0.32` | `+0.28` s | `4n` |
| **ornament** | `rand() < ornament` | Upper-neighbor grace note | `vel × 0.40` | `+0.11` s | `16n` |

- **Skip wins** — if skip fires, no extras stack on the silent note.
- **Harmony/echo/ornament can co-exist** on the same beat (rare).
- **Beat-0 protection** — the first beat of every bar can never be
  skipped. Without it, eight consecutive skips early in a piece
  could dissolve the sense of pulse entirely.
- **Rubato velocities are 32 – 45 % of melody velocity** — ornaments
  are whispers, not foreground. They sit *inside* the melody, not
  beside it.

---

### M19 · Arrangement rules *(layer layout, not per-note mappings)*

| Layer | Cadence | What plays | Velocity | Duration | Notes |
|---|---|---|---|---|---|
| **Piano melody** | every `4n` step | single note from M10 | `0.48 – 0.92` from slope | `2n` (or `1m` with pedal) | ±15 ms timing jitter |
| **Strings bed** | first beat of each 8-note bar | 4-note chord from M15 | `0.42 × stringsLevel` (M12) | `2 × barDur` *(overlaps into next bar)* | slow bowed swell |
| **Piano chord bloom** | first beat of every *other* bar | same voicing, octave up, arpeggiated | `0.28 × melodyVel` | `2n` per note | 40 ms stagger between notes |
| **Bass** | every 4 steps (half melody rate) | piano root, 2 octaves below | `0.42` | `1m` | gated by `bassEnabled` toggle |
| **Rubato extras** | probabilistic per note (M18) | varies | 32 – 45 % of melody vel | `16n` – `2n` | 0 – 0.28 s delays |

Deliberate design choices:

- **Strings held for 2 bars** so the release of chord N overlaps the
  attack of chord N+1 — no audible seam at chord changes.
- **Piano chord blooms every *other* bar** — every bar would feel
  too driven for a meditative piece. Alternating bars let the
  melody breathe in between.
- **Bass every 4 steps** (not every step) — anchors the pulse
  without competing with the melody.
- **Timing jitter ±15 ms** on the melody — micro-humanization so the
  grid doesn't sound mechanical.
- **Layer rhythmic stratification** — melody every beat, bass every
  4, strings every 8, piano bloom every 16. Each layer sits at a
  different rhythmic frequency; they don't overlap because they're
  not *trying* to occupy the same rhythmic slot.

---

## Part 2 — Principles that emerged

Rules that fell out of tuning the above. Useful background when you
isolate each transform into its own playground.

1. **Dominant ≠ most frequent.** M2 (tonal key) uses raw frequency
   because the key should follow mood. M3 (display palette) weights
   by vibrance because the *eye* weights by saturation. Same image,
   two different "dominants," for two different purposes.

2. **One data dimension per output parameter.** Warmth drives BPM.
   Lightness drives octave. Hue drives mode + root. If two inputs
   ever share an output, the result smears.

3. **Warmth, not brightness, drives energy.** Snow photos are bright
   but calm; storms are dark but urgent. Warmth (R − B balance)
   tracks perceived energy better than lightness does.

4. **Hard buckets where a human would — elsewhere, continuous.**
   Mode is bucketed (no interpolating between lydian and phrygian).
   BPM is continuous. Octave is bucketed. The shape of the mapping
   should match how the human perceives the axis.

5. **Per-piece normalization beats absolute normalization** wherever
   the input's dynamic range varies. See M11 — absolute height
   collapses flat landscapes; per-piece normalization preserves
   bar-to-bar variation even in a nearly-flat image.

6. **Squeeze the extremes.** M10 uses only the middle 70 % of the
   available note range. The edges of any continuous mapping are
   the worst-behaved in practice (outliers, clipping, ledger lines
   off the staff). Squeezing hides that without losing expressiveness.

7. **The palette has two jobs, one mapping each.** Dominant-by-
   frequency for tonal key (M2), dominant-by-vibrance-diversity for
   display (M3). Don't try to merge — they're answering different
   questions.

8. **Probability is the best hedge against deterministic boredom.**
   A fixed grid of notes always sounds like a fixed grid. Same grid
   with ~15 % perturbation per note sounds like music. Crucially,
   the probabilities themselves are tuned from *image mood* (M13),
   so the perturbation budget is responsive, not arbitrary.

9. **Stratify layers rhythmically.** Melody every beat, bass every
   4, strings every 8, chord bloom every 16 (M19). Each layer sits
   at its own frequency in the pulse. Layers don't fight for the
   same rhythmic slot because they're not occupying it.

10. **Voice the color note on top.** M15's third-on-top voicing is
    why the ear hears "this is minor" the instant the strings enter,
    before the melody gives it away. Position in the voicing encodes
    priority.

11. **Protect the downbeat.** Beat 0 of every bar is skip-protected
    (M18). Whatever else the rubato does, the pulse survives.
    Without this rule, aggressive images (high contrast) could
    dissolve their own rhythmic anchor.

---

## Part 3 — Audio engine plumbing *(fixed constants, not user-facing mappings)*

These aren't mappings — they're the physical-acoustic parameters of
the synth engine. Documented here because a change to any of them
shifts the "sound of the app" subtly but globally, and future
playgrounds for *sound design* would want them in one place.

### Signal chain

```
[piano sampler]  ──┐
                   ├─→ [reverb]  ──→ [Tone.Destination]
[cello sampler]  ──┘                      ├─→ [FFT analyser]  (visual only)
```

### Samplers

| Instrument | Base URL | Pitch anchors | Volume (dB) | Attack | Release |
|---|---|---|---|---|---|
| **Piano** (Salamander) | `assets/piano/` | A1, C2, C3, A3, C4, C5, A5, C6 | −6 | — | 3.2 s (6.0 s with pedal) |
| **Cello** | `assets/cello/` | C2, A2, C3, A3, C4, A4 | −14 | 1.2 s *(bowed swell)* | 4.0 s *(blend transitions)* |

Volume slider updates both: `piano = 20·log₁₀(v) − 6`,
`strings = 20·log₁₀(v) − 14`. Strings track piano but sit 8 dB under.

### Effects

| Node | Param | Value | Why |
|---|---|---|---|
| Reverb | `decay` | 7 s | Long tail → ensemble / space feel |
| Reverb | `wet` | 0.42 | Just over a third — present but not washed |
| FFT | `size` | 512 bins | Enough resolution for the log-spaced display |
| FFT | `smoothing` | 0.72 | Graceful motion in the spectrum strip |

### Transport / loop

- `Tone.Transport.scheduleRepeat(callback, '4n')` — every quarter-note
- Loop mode: index wraps back to 0 when it hits `notes.length`
- On loop, `currentChordBar` resets to `-1` so strings retrigger
- `stop()` calls `releaseAll()` on both samplers so hanging notes die
  immediately (important for quick-repeat sample tile clicks)

---

## Part 4 — Isolation plan (media-pipe style)

### What makes `media-pipe` a good template

- **Single self-contained HTML file.** No build, no deps.
- **Multiple interaction modes** for the same underlying signal.
  Each mode tests a different *question* — accuracy, interference,
  switch latency.
- **Live numeric output visible** (confidence scores for each
  class, all on screen at once).
- **Research framing** — explicit assumptions in a banner comment,
  explicit failure modes, explicit "this tests X."

The pattern scales to any signal-processing pipeline: the thing you're
tuning is always "given this input, is the output right / consistent
/ fast?" A playground that surfaces the answer in numbers, side-by-
side with alternative interpretations, lets you iterate the rules
without reasoning about the whole app around it.

### Proposed playground structure

```
experiments/
  skylinemusic-palette/        M3
    index.html
    test-images/
      forest.jpg               labeled cases
      city.jpg
      sunset.jpg
      monochrome.jpg           edge: no saturated pixels
      accent-only.jpg          edge: 99% grey + 1 neon pixel
      near-dup.jpg             edge: 4 slightly different blacks
    README.md
  skylinemusic-hue-mode/       M4
    index.html                 (+ an HSV-wheel synthetic input)
    README.md
  skylinemusic-silhouette/     M1
    index.html                 (v1/v2/v3 side-by-side + constants sliders)
    test-images/
    README.md
  skylinemusic-scalars/        M5-M9, M12
    index.html                 (RGB inputs → root, octave, BPM, metrics)
    README.md
  skylinemusic-rubato-prob/    M13
    index.html                 (metric sliders → live probability bars)
    README.md
  skylinemusic-chord-motion/   M11 + M14–M17
    index.html                 (silhouette curve sliders → chord progression)
    README.md
```

Each playground's `index.html` should include:

1. **Header comment** — what this tests, the research question, what's
   out of scope
2. **Input surface** — drag-drop image OR synthetic generator (hue
   wheel for M4, height-curve sliders for M10, metric sliders for M13)
3. **Algorithm toggles** — side-by-side mode buttons, like `v1 | v2 |
   v3` in silhouette. Include "naive / current / alternative" when
   they exist.
4. **Output visualization** — actual result plus the raw numbers
   (swatches, curve, BPM number, probability bars, chord progression)
5. **Comparison view** — stack outputs so you can A/B by eye
6. **Test-case runner** — loop through `test-images/`, show each
   result with the "expected" answer pinned beside it when known
7. **Export** — download the output as JSON for regression tests

### Recommended order

Build in this order — it's the order of "biggest design-decision
density per line of code":

1. 🥇 **M3 Palette** — 5 judgment calls in ~80 lines. Swatches make
   quality obvious. Best "dominant vs frequent" story. **Start here.**
2. 🥈 **M1 Silhouette** — already has v1/v2/v3 A/B baked in; just
   lift it into its own page with a regression suite.
3. 🥉 **M4 Hue → Mode** — simplest possible playground, great
   template exercise. The fuzzy bucket boundaries *are* the design.
4. **M5 – M9 + M12 scalar cluster** — combine into one playground.
   Each is "RGB/HSL → one number"; quick to build side by side,
   and seeing them all on one page reinforces principle #2 ("one
   dim per output").
5. **M13 Image metrics → probabilities** — excellent visual-only
   playground. Four sliders (b, c, w, s) → four live probability
   bars. No audio needed; the math *is* the test.
6. **M11 + M14 – M17 Chord motion** — silhouette curve sliders →
   chord progression output as chord-strip chips. Visualizes M11's
   three rules + M15 voicing + M16 labeling simultaneously.
7. **M10 + M18 Silhouette → notes + rubato** — needs audio to
   evaluate properly. Save for last.
8. **M19 Arrangement** — not really a mapping; probably not worth
   isolating. Would become a listening test anyway.

### Starter template (skeleton for any playground)

```html
<!--
  SkylineSound — <NAME> Playground
  ==================================
  Isolates the <NAME> mapping from the main app so we can test it
  against labeled inputs without spinning up audio, score, or canvas.

  RESEARCH QUESTIONS:
  - Does the output match what a human would call "<right answer>"?
  - Where does the algorithm disagree with intuition?
  - How sensitive is the output to each tuning constant?

  INPUTS: drag-drop image files → onto the drop zone
  MODES:  <mode A> | <mode B> | <mode C>
  OUTPUT: <swatches / curve / number / probability bars / chord chips>

  Run: python3 -m http.server 8000
-->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title><NAME> Playground</title>
  <style>
    :root { --ink:#1B2230; --ink-3:rgba(27,34,48,.52);
            --bg:#EEF1F5; --accent:#FF7A4D; }
    /* ... copy tokens from skylinemusic/css/styles.css */
  </style>
</head>
<body>
  <header>
    <h1><NAME> playground</h1>
    <div class="modes">
      <button data-mode="naive" class="is-active">naive</button>
      <button data-mode="current">current</button>
      <button data-mode="alt">alt</button>
    </div>
  </header>

  <section class="input">
    <!-- drag-drop OR synthetic generator -->
  </section>

  <section class="output">
    <!-- visualization of current mode's result -->
  </section>

  <section class="compare">
    <!-- all three modes side by side on the same input -->
  </section>

  <section class="tests">
    <!-- labeled test cases with pass/fail indicators -->
  </section>

  <script>
    // Copy the mapping function from the main repo, verbatim.
    // DO NOT import — each playground owns its own copy so it doesn't
    // break when the main repo refactors.
    function mappingCurrent(...) { ... }
    function mappingNaive(...)   { ... }
    function mappingAlt(...)     { ... }

    // Test cases with expected answers
    const TESTS = [
      { image: 'test-images/forest.jpg', expect: { ... } },
      // ...
    ];
  </script>
</body>
</html>
```

### Testing philosophy

**These aren't unit tests.** They're playgrounds that *surface the
tests you'd want to write*. Two failure modes to expect:

- **The "right answer" isn't defined** — for M3, "what's the right
  palette for this forest photo?" is a judgment call. Use
  **regression testing**: capture the current output as baseline
  JSON, alert when it changes. Reviewer eyeballs the new output;
  if it's better, update the baseline.

- **The "right answer" is only visible in context** — for M4,
  whether a blue image should be `minor` or `pentatonic` depends
  on the final piano piece sounding right. Some mappings will
  **only** be meaningfully testable via the end-to-end app.
  Isolate those playgrounds for the *components* of the mapping
  (the hue → bucket logic separate from "does minor feel right"),
  not the whole thing.

When in doubt, optimize the playground to answer *"which of these
three alternatives wins on this input?"* — that's always useful,
even when "is this objectively correct?" isn't well-defined.

### Cross-cutting concerns

- **Shared test images.** Put `skylinemusic-test-images/` somewhere
  central and symlink into each playground. A forest that exercises
  M3 also exercises M8 (contrast metric).
- **Keep copies of the mapping functions, not imports.** Each
  playground is a museum — it preserves the version of the mapping
  that was state-of-the-art when it was built. If the main repo's
  mapping changes, the playground's old copy is the comparison.
- **Name versions numerically.** `extractPaletteV1`, `V2`, etc.
  When the main repo adopts what's currently `V3` in the palette
  playground, rename main's function to match.

---

## Appendix — Mapping matrix at a glance

| Id | Input | Output | Lines | Design knobs |
|---|---|---|---|---|
| **M1** | canvas | Float32Array[W] | ~200 | `alpha=0.08, beta=0.55, skyPenalty=0.15, maxDy=2`, blur radius 7, median r=3 |
| **M2** | canvas | `{r,g,b,h,s,l}` | ~30 | grid stride `w/60 × h/60`, `k=3`, 4-bit bucket |
| **M3** | canvas | 5 swatches | ~80 | `MIN_DIST=45`, score weights `0.55/0.45`, vibrance formula, `s > 0.12` gate |
| **M4** | `(h,s)` | mode name | ~10 | 8 bucket boundaries + `s < 0.15` gate |
| **M5** | `h` | root name | ~3 | circle-of-fifths array order |
| **M6** | `l` | octave `3\|4\|5` | ~3 | `0.25, 0.55` thresholds |
| **M7** | `(r,g,b)` | BPM | ~3 | `base=68, range=±8` |
| **M8** | canvas | `{b, c, sS}` | ~20 | grid stride 80, `× 3.2` calibration |
| **M9** | palette | `{aSat, aWarmth}` | ~10 | `s > 0.2` filter, top 2 |
| **M10** | `(profile, N)` | `notes[], vels[]` | ~50 | `PITCH_SQUEEZE=0.7`, slope norm `0.18`, velocity base `0.48 + 0.44` |
| **M11** | `(profile, N)` | bar degrees | ~30 | bar size 8, slope threshold `±0.12` |
| **M12** | `aSat` | `stringsLevel` | ~5 | base `0.3`, range `0.7` |
| **M13** | `{b,c,w,sS}` | 4 probs | ~15 | 8 formula constants, ranges 1.5–13 % |
| **M14** | scale name | Roman style | ~5 | "minor-ish" set: `{minor, phrygian, dorian}` |
| **M15** | `k, scale` | 4-note voicing | ~15 | `chordOct = clamp(2,4, baseOctave−1)`, voicing `[root, 5, 8, 3↑]` |
| **M16** | `thirdOff` | quality label | ~5 | `{3:'m', 4:'', 2:'sus2'}` |
| **M17** | scale name | interval set | table | 8 scales, 5–7 notes each |
| **M18** | note event | `{skip, extras[]}` | ~40 | velocity scalars `0.45/0.32/0.40`, delays `0/0.28/0.11`, beat-0 protection |
| **M19** | — | layer cadences | — | bar size 8, bass stride 4, bloom every 2 bars, jitter ±15 ms, strings × 2 bars |

Total mapping code: ~700 lines across four JS files. Nineteen tunable
transforms with well-defined inputs and outputs. Every one of them
is a candidate for its own playground; the ones most worth isolating
first are **M3, M1, M4, M13** in that order.
