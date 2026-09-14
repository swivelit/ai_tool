# CLI terminal UI acceptance recording

This is a sanitized, non-billable acceptance note for the local
`0.2.0-rc.2` candidate. Installed controller/event coverage uses a disposable
fake terminal and controlled API fixtures; no real credential or provider was
used. The release check reports native PTY coverage separately when the host
can allocate one.

Fresh-prefix executable:

```text
The exact fresh-prefix executable is recorded by the final release-check run
and the external artifact report; temporary release prefixes are deleted after
the check.
```

The real PTY transcript showed:

```text
╭──────────────────────────────────────────────────────────────────╮
│ Swico 0.2.0-rc.2 · Swico Lite                                    │
│ <workspace> · main                                                │
╰──────────────────────────────────────────────────────────────────╯
· Ready · Enter sends · Ctrl+J inserts a newline · Ctrl+C cancels
> Ask Swico anything…
```

The installed controller path exercises routing status before deltas, quality,
completion, fragmented input, paste, Unicode and cleanup. The native PTY probe
was NOT RUN in the managed non-TTY host (`tcgetattr` is unavailable); this is
not native terminal/platform acceptance. Narrow/wide visual review and the
Windows PTY path remain host/CI checks, not a paid-Chat or agent-readiness
claim.
