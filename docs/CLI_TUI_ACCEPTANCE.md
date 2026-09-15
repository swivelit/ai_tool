# CLI terminal UI acceptance recording

This is a sanitized, non-billable acceptance note for the local
`0.2.0-rc.8` candidate. Installed controller/event coverage uses a disposable
fake terminal and controlled API fixtures; no real credential or provider was
used. The release check reports native PTY coverage separately when the host
can allocate one.

Automated fresh-prefix installed PTY acceptance:

```text
PASS: PTY positive control (child stdin/stdout are TTYs)
PASS: installed rich terminal with controlled API
PASS: routing/status before deltas, /usage, two turns, Ctrl+C cancellation,
      /exit, and terminal cleanup
PASS: bounded startup diagnostics reached rich-ui:restored
```

The real PTY transcript showed:

```text
╭──────────────────────────────────────────────────────────────────╮
│ Swico 0.2.0-rc.8 · Swico Lite                                    │
│ <workspace> · main                                                │
╰──────────────────────────────────────────────────────────────────╯
· Ready · Enter sends · Ctrl+J inserts a newline · Ctrl+C cancels
> Ask Swico anything…
```

The installed controller path exercises routing status before deltas, quality,
completion, fragmented input, paste, Unicode and cleanup. The release check's
Unix helper uses `pty.fork()` and waits for the real child close status; it does
not use BSD `script` with pipe input and does not synthesize success by sending
`/exit` and killing the child. This is automated PTY evidence on the host where
the check ran, not a claim that every operator Terminal, Windows console, or
native coding sandbox is accepted. The Windows path uses the dev-only pinned
`node-pty` ConPTY adapter and the RC8 helper emits a `[conpty-result]` sentinel
only after the bridge result and bounded diagnostics are flushed. The local Mac
run does not itself provide Windows evidence; the clean Windows path passed in
CI run `34911573230`, including the native helper and installed rich terminal.
