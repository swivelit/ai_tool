# Backchannel cue clips

These are the short "listening" acknowledgement sounds the assistant plays while
the user is talking (see `mobile/lib/backchannel.ts`). They are the spoken nods
a human makes — "aaha", "hmm", "mm-hmm" — emitted on a randomized ~3–7s cadence
and stopped the instant the user stops speaking or the assistant starts talking.

## Current clips

This folder includes short synthetic WAV clips so the app has real bundled
assets and Metro never sees missing audio files. They are intentionally quiet and
under about 300ms. Replace them with real, natural acknowledgement recordings
before shipping this as production audio.

## Bundled files

| Cue       | Bundled file |
| --------- | ------------ |
| `aaha`    | `aaha.wav`   |
| `hmm`     | `hmm.wav`    |
| `mm-hmm`  | `mm-hmm.wav` |

The cue map lives in `clips.ts` and is passed through
`createBackchannelController({ clips: BACKCHANNEL_CLIPS })`.

## Recording guidance

- Keep each clip **short** (roughly 0.2–0.4s) and **quiet** — these should sit under
  the user's voice, not interrupt it. Playback volume is further attenuated in
  `createBackchannelController` (`volume` option, default `0.65`).
- Mono WAV or MP3 is plenty. Trim leading/trailing silence so the cue fires
  promptly.
- Record a few natural variants if you like and extend the `clips` map / cue
  list in `lib/backchannel.ts`.

## Wiring

`createBackchannelController()` resolves these files lazily (only when a cue
actually plays), so the pure scheduling logic in `backchannel.ts` stays unit
testable in node. `mobile/lib/backchannel.ts` still has data-URI fallbacks for
tests or experiments that construct a controller without bundled clips.
