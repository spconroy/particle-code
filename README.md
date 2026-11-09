# ParticleCode

**An open, color-particle screen-to-camera data channel.** Type text on one screen; a
swirling cloud of colored particles encodes it; any phone camera — using just a web
page — decodes it. No network, no pairing, no app.

Inspired by Apple's Quick Start particle cloud (the floating-dot swirl you see when
migrating to a new iPhone). That format is proprietary and undocumented — ParticleCode
is the open answer to the same problem: *get bits from screen A to camera B through
colored light, reliably.*

```
you type ──▶ 160 particles, 8 colors ──▶ camera ──▶ HSV classify ──▶ homography
             (3 bits each, RS-protected)             + hue calibration
                                                          │
             ◀──────── your text, decoded ──── Reed–Solomon ◀─ voting
```

## Try it

Two devices (a laptop to send, a phone to receive):

```bash
git clone https://github.com/spconroy/particle-code.git
cd particle-code
python3 -m http.server 8143
```

- **Sender** — open `http://localhost:8143` on the laptop. Type in the payload box;
  the cloud re-encodes live as you type.
- **Receiver** — open the same page on the phone (same Wi-Fi, `http://<lan-ip>:8143`),
  switch to **Receive**, start the camera, and point it at the cloud from 20–40 cm.
  Browsers require a secure context for camera access, so for phone testing serve over
  HTTPS (e.g. `cloudflared tunnel --url http://localhost:8143`) or host it anywhere static.

No second device? Hit **Run simulated end-to-end test** on the Receive tab — it renders
the constellation with synthetic rotation, scale, hue shift, brightness, and sensor noise,
then decodes it through the exact production pipeline.

## How it works

| Layer | Choice | Why |
|---|---|---|
| Symbols | 8 colors = 3 bits/particle | A camera channel (auto white balance, exposure, chroma subsampling) can't carry 24-bit color; decades of color-barcode research (Microsoft HCCB, COBRA, PixNet) converge on small palettes + strong ECC |
| Palette | 6 hues on a 60° wheel + 2 grays | Hue maximally separated; grays survive white-balance drift because they're luminance-coded |
| Cell grid | 160 anchored slots (16×10), particles wander within their cell | Symbol identity comes from geometry — zero bits spent on ordering |
| Localization | Solid white capsule bar (TL) + 3 solid circles, detected by rotation-invariant **area ratio** (~2.8× a single), then a 4-point **homography** | Finder patterns QR-style: crisp, glare-resistant, perspective-rectifying; the bar disambiguates orientation |
| Hue calibration | 3 RGB satellites of known hue measured per frame → global hue-rotation correction before classification | Defeats auto white balance |
| Timing | States dwell ~1.2 s: 45% swirl, then settle exactly onto anchors; temporal voting across frames | Blurred transition frames are simply discarded; the settle phase is the clean sample |
| Error correction | CRC-16 per block + **Reed–Solomon(60,49) over GF(256)** per state (t=5 byte errors); blocks cycle continuously | Any subset of states, in any order, reconstructs the message; missed frames just wait for the next cycle |
| Live editing | A `session` byte in every block bumps on each sender edit | The receiver drops stale blocks the moment you edit the text |

One 60-byte state carries `[id][total][session][len][payload…43][CRC-16]` + 11 RS parity
bytes. Throughput after overhead: **~130 B/s** — enough for contact cards, Wi-Fi
credentials, TOTP seeds, keys, and short text in a few seconds. (An animated-QR pipeline
moves ~50× more data; ParticleCode trades bandwidth for a format people enjoy pointing
cameras at.)

## Payload types

The codec carries UTF-8, so it speaks the standard QR payload conventions out of the box — the sender builds them from structured forms, the receiver recognizes the decoded string and offers the web-native action (open the link, copy the Wi-Fi password, save a `.vcf`, open the map…):

URL · `WIFI:` (with proper `\\;,:"` escaping) · vCard 3.0 · `mailto:` · `tel:` · `SMSTO:` · `geo:` · `otpauth://totp` · plain text

## Repo layout

- `index.html` — the whole app: sender (canvas particle renderer) + receiver (camera
  pipeline with live overlay) + built-in simulator. Zero dependencies; works from any
  static host.
- `codec.js` — the format: palette, layout geometry, CRC-16, from-scratch GF(256)
  Reed–Solomon encoder/decoder, block framing, homography solver. Runs in browser and Node.
- `test.cjs` — verification harness: `node test.cjs`

## Verification

- **Codec (Node):** 300/300 randomized RS error-injection trials; framing roundtrips
  (incl. Unicode); 2 flipped symbols per state always recover; homography recovers
  projective maps to 1e-6 px.
- **End-to-end (in-page simulator):** 11–12 of 12 trials decode under randomized
  rotation (±8°), scale (0.84–0.97), hue shift (±14°), brightness (0.84–1.04) and
  per-pixel noise (σ 6–15), latching at the minimum 8 frames. Failures occur only when
  the anchors leave the frame — by design.

## Limitations & roadmap

- v0 targets well-lit, hand-steady, screen-fills-view conditions. Glare is the enemy.
- Roadmap: Luby-transform fountain coding (instead of cyclic repetition), per-cell
  adaptive thresholds, camera exposure lock via `applyConstraints`, 16-color calibrated
  palette (4 bits/particle), WASM decode pipeline, screen-to-screen duplex.

## Prior art

- Apple Quick Start / Apple Watch pairing animation — the proprietary particle-code
  inspiration (undocumented; see Apple's Platform Security guide for the migration
  handshake it belongs to).
- Microsoft HCCB / Tag — shipped color barcode (2009–2015), 4–8 colors.
- [txqr](https://github.com/divan/txqr), Blockchain Commons **UR** — animated-QR
  transfer with fountain codes, the throughput champions of this category.

## License

MIT
