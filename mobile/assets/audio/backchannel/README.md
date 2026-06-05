# Backchannel cue clips

These are the short "listening" acknowledgement sounds the assistant plays while
the user is talking (see `mobile/lib/backchannel.ts`). They are the spoken nods
a human makes — "aaha", "hmm", "mm-hmm" — emitted on a randomized ~3–7s cadence
and stopped the instant the user stops speaking or the assistant starts talking.

## Files (drop real recordings here, same names)

| Cue       | File         |
| --------- | ------------ |
| `aaha`    | `aaha.mp3`   |
| `hmm`     | `hmm.mp3`    |
| `mm-hmm`  | `mmhmm.mp3`  |

The files currently checked in are **placeholders** (not real audio). Replace
each with a real recording of the same name. The controller loads whatever is at
these paths via `require(...)`, so no code change is needed once you swap them.

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
