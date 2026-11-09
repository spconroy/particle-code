# Experiments

Research log for candidate format extensions. Each entry states the question,
the method, and the measured result.

## 1. Size channel — can particles carry a bit in their size? (2026-11-09)

**Question:** color gives 3 bits/particle. Does a binary size (small vs ~1.38x)
add a 4th bit reliably through the camera pipeline?

**Method:** simulate the full channel (rotation ±6°, scale 0.80–0.90, brightness
0.92, per-pixel noise σ8–12) with random size-bits; decode by counting on-dot
pixels (v>130, s>60) inside each slot's sampling disc.

**Findings:**
1. *Absolute calibration fails.* A solid white anchor is the wrong ruler for
   glow-sprite dots — the sprite's luminance profile extends ~1.3x past its
   nominal radius (measured area gain ≈ 1.66x). Thresholds built from nominal
   areas misclassify both sizes as "big" (BER ≈ 46–48%, constant across noise —
   the signature of a calibration bug, not channel noise).
2. *Population decoding wins.* Normalize each slot's count by its expected
   small-size area, then 2-means cluster the 160 normalized counts and classify
   by membership. Requires the encoder to whiten size bits to ~50/50 density
   (guaranteed by scrambling), making the histogram bimodal. No calibration
   needed — the same "use the population, not the pixel" trick as color voting.
3. **Result: BER 0.0%** over 2,560 bits, all conditions, cluster separation
   1.44 (big class ≈ 2.4x the small class's normalized count).

**Cost/trade:** +1 bit/particle = 80 B/state (+33% capacity), but size can no
longer carry smooth decorative depth — depth would quantize to the two data
levels (brightness/parallax depth cues remain). Real-camera defocus and video
compression stress size *measurements* harder than hue argmax; the phone test
is the true gate.

**Status:** proven in simulation; not yet integrated into the protocol (v2
candidate — competes with payload-aware scene casting for the same v2 slot).

## 2. Payload-aware scene casting ("yellow sun") — analysis (2026-11-09)

**Question:** can data symbols be spatially cast into roles (all yellows →
core), so the message itself paints the scene?

**Analysis:** the colors are chosen by the message bytes; clustering by value
requires reordering the symbol stream, and any value-based reordering destroys
bit order. Recovery requires transmitting an interleave map (~3 bits/symbol ≈
one extra block per message). Feasible; protocol v2 candidate. Decor-only
scenes (solar, clouds, fire, jet) shipped meanwhile.
