# SkylineSound — Next Pass Implementation Plan

Eight pending tweaks, grouped into four phases so we don't touch everything at once. Each phase is a single focused batch — roughly one commit's worth. Clarifying questions are inline; answer the ones marked **DECIDE** before the phase starts and I can usually do the rest in one shot.

---

## Phase 1 — Visual pass (aesthetic + layout)

**Covers tweaks:** 3 (palette, upload page), 4a (glowing orange accent), 5 (score sizing), 4b (growing line animation — visual half)

This is the cheapest batch: all CSS + a little DOM. No audio touched, no analysis touched.

### 1.1 Global palette — kill the beige

Current scheme leans warm cream. Proposal:

- **Background:** near-white `#F7F8FA` OR soft blue-gray `#EEF1F5`. Not pure white — that reads "unfinished."
- **Surface cards / panels:** `#FFFFFF` with a 1px `#E3E8EF` hairline.
- **Primary text:** `#1B2230` (near-black, slightly blue).
- **Muted text:** `#6B7280`.
- **Accent (see 1.2):** the glowing orange.

**DECIDE:**
- **Q1.** White background (`#F7F8FA`) or soft blue-gray (`#EEF1F5`)? The poppy reference has a blue-gray backdrop — I lean that way for continuity with your aesthetic ref, but white gives the score more room to breathe. Pick one.

### 1.2 Accent color — "glowing orange"

The poppy ref is a luminous coral-orange with a slight pink bloom, not a flat safety orange. Proposal:

- **Primary accent:** `#FF7A4D` (warm coral) OR `#FF8A5B` (softer, more peachy).
- **Glow treatment:** wherever the accent paints a line/stroke, add a `filter: drop-shadow(0 0 8px rgba(255,122,77,0.45))` so it reads as emitted light, not paint.
- Apply to: the analyzed silhouette line, the active-note indicator on the score, play/pause button focus ring.

**DECIDE:**
- **Q2.** `#FF7A4D` (punchier) or `#FF8A5B` (softer)? I'll mock both if you want — cheap.
- **Q3.** Should the glow pulse gently (breathing animation, ~3s cycle) or stay static? Pulsing is more "alive" but can get annoying on loop.

### 1.3 Upload page — preselected thumbs first

Current: big drop zone, then thumbnails. Proposal:

- Lead with a row of 3–4 preselected thumbs (Seattle, Rainier, + 1–2 more), each ~120×80px with rounded corners.
- Below them: a thin divider with the text **"or upload your own"** centered.
- Drop zone becomes smaller / secondary underneath.

**DECIDE:**
- **Q4.** Which images go in the preselected row, and in what order? Current assets? Should I add 1–2 more (a sunset, a purple dusk) to give the mode/color mapping more variety to show off?

### 1.4 Score UI — smaller, cleaner

Current score is fairly tall and the noteheads are still a touch bold even after the last pass. Proposal:

- Staff height: reduce by ~25% (lineSpacing drops from current value to ~75%).
- Notehead radius: proportional reduction, keep current 0.68 ink alpha.
- Barlines: one shade lighter (`#C4CAD3`).
- Score container gets a subtle top border only, not a full card — lets it sit closer to the image.

No decisions needed — I'll just do it. If it goes too small, we bump it 10% back up.

### 1.5 Silhouette "growing" line animation

This is the visual half of tweak 4. (The detection-quality half is Phase 3.)

- After analysis completes, draw the silhouette line with a left-to-right reveal using `stroke-dasharray` / `stroke-dashoffset` on an SVG path, ~1.5s ease-out.
- Combine with the glowing orange accent so it feels like a pen of light tracing the ridge.

**DECIDE:**
- **Q5.** Should the line stay visible after it finishes drawing, or fade to a thinner/dimmer state so it doesn't compete with the score below?

---

## Phase 2 — Audio layers + controls

**Covers tweaks:** 1 (piano chords + generative synth), 2 (continuous strings + visibility), 6 (pedal blend toggle)

This is the biggest batch in complexity. I'll want Phase 1 merged first so we're layering new work on a stable visual foundation.

### 2.1 Continuous strings (tweak 2a)

Current: one `triggerAttackRelease` per bar, ~20% overlap into the next bar. You hear a faint seam on chord changes.

Two options:

- **Option A — Sustained overlap.** Keep `triggerAttackRelease` but extend duration to `barDur * 2.0` and rely on the Sampler's natural release (4.0s) to smear transitions into a glassy wash. Simplest; minimal code change.
- **Option B — Held-and-morphed.** Hold one chord via `triggerAttack` and morph voicings by retriggering only the notes that change between bars, so common tones (e.g., the root) never re-articulate. More authentic "legato strings" feel but noticeably more code.

**DECIDE:**
- **Q6.** Option A (quick, 90% of the effect) or Option B (correct, 100% of the effect)? My recommendation is A for this pass — if it's not enough we upgrade to B later.

### 2.2 Strings visible as a layer in UI (tweak 2b)

Right now the strings are invisible — you hear them but don't see them acting. Proposal:

- Below the main score, add a **compact chord-bed strip** (~40px tall): horizontal bars representing each held chord, width = bar duration. Bars glow the accent color on the currently-playing bar.
- Optional: label each bar with the chord name (I, IV, V) or the voicing (e.g., "Cmaj").

**DECIDE:**
- **Q7.** Chord strip above or below the main score? Above puts it in the same visual "staff" grouping; below keeps the melody score as the primary read.
- **Q8.** Label with roman numerals, chord names, or no label (purely visual)?

### 2.3 Piano chords layer (tweak 1a)

Right now the piano plays a single-note melody. Proposal:

- On beats where silhouette slope is low (flat stretches), the piano drops a soft broken chord built from the scale degree of that bar's bass note. Keeps the flat stretches from feeling thin.
- Velocity for the chord tones: 60% of the melody velocity so the top line still sings.

**DECIDE:**
- **Q9.** Chord every bar, every other bar, or only on flat stretches (adaptive)? Adaptive is musically interesting but harder to predict; every-other-bar is a reliable rhythmic anchor.

### 2.4 Generative synth layer (tweak 1b)

Non-deterministic, image-informed. Proposal:

- **Trigger logic:** derive a "density" param from overall image light/dark ratio. Bright images → sparse, high-register pings; dark images → slower, low-register drones.
- **Sound:** `Tone.AMSynth` or `Tone.FMSynth` with a bell-like envelope (fast attack, slow decay). NOT a pad — something crystalline and airy.
- **Pitch selection:** always stays in the current scale, but pitch class + octave picked randomly each trigger, weighted toward the upper register.
- **Timing:** random interval 1.5–6s between triggers, seeded per-image so each image has a consistent personality but playback feels alive.

**DECIDE:**
- **Q10.** What should "light/dark ratio" drive? Options:
   - (a) density only (bright = more frequent, dark = sparser)
   - (b) density + register (bright = high & frequent, dark = low & sparse)
   - (c) density + timbre (bright = bell-like, dark = breathy/detuned)
- **Q11.** Stereo placement — should the synth pan randomly in the stereo field, or stay centered?
- **Q12.** Volume relative to piano: whisper-quiet (-20dB, ambient decoration) or present (-12dB, a clear third voice)? I'd start whisper-quiet.

### 2.5 Pedal toggle (tweak 6)

A temporary UI control to hear the piano with longer sustain.

- Add a small toggle near transport controls: **"Pedal"** (default off).
- When on: bump piano sampler `release` from 3.2 → 6.0, and increase note duration from `2n` → `1m` so notes ring into each other.
- When off: revert to current values.

Trivial. No decisions.

---

## Phase 3 — Skyline detection upgrade

**Covers tweak 7** (and closes out tweak 4's detection-quality half)

The Rainier reference shows the current detection missing the main peak's shoulder and drifting into cloud. Worth a real investigation before writing code.

### 3.1 Research spike (no code)

Frameworks / approaches to evaluate:

1. **OpenCV.js** — full OpenCV in the browser (~8MB WASM). Gives us Canny edge detection, morphological ops, contour extraction. Proven, heavy download.
2. **@tensorflow-models/body-pix / deeplab** — semantic segmentation models. Overkill for skyline but extremely robust. ~5–25MB model download.
3. **Custom improved algorithm** — stay framework-free but upgrade the current approach: (a) blur first to kill noise, (b) use Sobel/Canny gradient instead of per-column threshold, (c) column-wise top-most-edge extraction with continuity constraint (reject jumps > N px unless gradient magnitude is very high).
4. **MediaPipe Selfie Segmentation** — ~200KB model, but it's tuned for people not landscapes.

**My recommendation:** Start with #3 (custom-improved) — zero dependencies, addresses the specific Rainier failure modes (cloud false positives, missed shoulders). If that doesn't close the gap, go to OpenCV.js for Canny + contour.

**DECIDE:**
- **Q13.** Are you OK with the 8MB OpenCV.js cost if #3 isn't enough? If not, we stop at "custom-improved" and accept its ceiling.
- **Q14.** Should the app show a before/after toggle during development so you can compare old vs. new detection on the same image? Useful for tuning.

### 3.2 Implementation (after research is decided)

Either way, the silhouette extraction API stays the same — only the internals of `SilhouetteExtractor` change. That keeps the downstream music pipeline untouched.

---

## Phase 4 — Spectrogram visualization

**Covers tweak 8**

After line analysis completes, show a small live spectrogram box. Proposal:

- Use `Tone.Analyser('fft', 256)` on the reverb output bus.
- Draw a 200×60px canvas below the image preview (or in the score area).
- Color the spectrum bars with the accent color, gradient from transparent at bottom to full-accent at top.
- Only paints while audio is playing; greys out / freezes on pause.

**DECIDE:**
- **Q15.** Placement:
   - (a) Right under the image, above the score (emphasizes "this image → this sound")
   - (b) Right of the transport controls (treats it as a meter)
   - (c) Overlay on the image itself, lower-right corner with 70% opacity
- **Q16.** Spectrogram (waterfall, time × frequency scrolling) or just a live spectrum analyzer (single moment, frequency × magnitude)? Spectrum is cheaper to render and usually reads better at small sizes. You said "sonogram" which is a spectrogram — confirm?

---

## Suggested sequencing & batching

To honor the efficiency concerns from last round:

1. **Answer Q1–Q16 in one pass.** Most are yes/no or A/B. That unblocks everything.
2. **Phase 1 in one commit.** All CSS + upload layout + score sizing + line-draw animation. Single verification at the end: one screenshot per image, confirm aesthetic.
3. **Phase 2 in one commit.** All three audio layers + pedal toggle + chord-strip UI. Verification: play both test images end-to-end, listen for seams.
4. **Phase 3 in its own track.** Research doc first → decision → implementation. Don't bundle this with Phase 2 — detection changes can break the silhouette pipeline and should be isolated.
5. **Phase 4 last.** Spectrogram is purely additive, zero risk to anything else.

Rough credit/time estimate: Phase 1 ≈ 1 batch, Phase 2 ≈ 2 batches (one for audio logic, one for UI strip), Phase 3 ≈ 1 research + 1 impl, Phase 4 ≈ 1 small batch.

---

## Summary of decisions needed

| # | Question | My default if you don't answer |
|---|---|---|
| Q1 | Background: white or soft blue-gray? | soft blue-gray `#EEF1F5` |
| Q2 | Accent: `#FF7A4D` or `#FF8A5B`? | `#FF7A4D` |
| Q3 | Accent glow: pulse or static? | static |
| Q4 | Preselected images + order? | current two, Seattle first |
| Q5 | Silhouette line after animation: stay or dim? | dim to 40% |
| Q6 | Strings: Option A or B? | A (sustained overlap) |
| Q7 | Chord strip: above or below score? | below |
| Q8 | Chord strip labels? | roman numerals |
| Q9 | Piano chords: every bar, every other, or adaptive? | every other bar |
| Q10 | Light/dark drives density / register / timbre? | density + register |
| Q11 | Synth pan random or centered? | centered |
| Q12 | Synth level: whisper or present? | whisper (-20dB) |
| Q13 | OK with 8MB OpenCV.js if needed? | no, stop at custom-improved |
| Q14 | Before/after detection toggle? | yes, dev-only |
| Q15 | Spectrogram placement? | (a) under image, above score |
| Q16 | Spectrogram or spectrum analyzer? | spectrum analyzer (cheaper, reads better small) |

Answer with just the question numbers and your picks — e.g. "Q1: blue-gray, Q2: 7A4D, Q3: static, …" — and I'll start Phase 1.
