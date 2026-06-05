# Backchannel cue clips

These are the short "listening" acknowledgement sounds the assistant plays while
the user is talking (see `mobile/lib/backchannel.ts`). They are the spoken nods
a human makes — "aaha", "hmm", "mm-hmm" — emitted on a randomized ~3–7s cadence
and stopped the instant the user stops speaking or the assistant starts talking.

## Placeholder status

The app currently uses tiny synthetic WAV data-URI placeholders in
`mobile/lib/backchannel.ts`, not checked-in human recordings. This avoids Metro
missing-asset failures while keeping the controller active. Replace those
placeholders with real, short acknowledgement recordings before shipping this as
production audio.

## Suggested files if replacing placeholders

| Cue       | File         |
| --------- | ------------ |
| `aaha`    | `aaha.mp3`   |
| `hmm`     | `hmm.mp3`    |
| `mm-hmm`  | `mmhmm.mp3`  |

After adding real files, either pass them through
`createBackchannelController({ clips: { aaha: require(...) } })` or update
`defaultClipSources()` in `mobile/lib/backchannel.ts` to point at them.

## Recording guidance

- Keep each clip **short** (≈0.4–1.2s) and **quiet** — these should sit under
  the user's voice, not interrupt it. Playback volume is further attenuated in
  `createBackchannelController` (`volume` option, default `0.65`).
- Mono, 44.1kHz MP3 is plenty. Trim leading/trailing silence so the cue fires
  promptly.
- Record a few natural variants if you like and extend the `clips` map / cue
  list in `lib/backchannel.ts`.

## Wiring

`createBackchannelController()` resolves these files lazily (only when a cue
actually plays), so the pure scheduling logic in `backchannel.ts` stays unit
testable in node. To point at different assets without touching the defaults,
pass `clips` into `createBackchannelController({ clips: { aaha: require(...) } })`.
