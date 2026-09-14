# CLI terminal UI acceptance recording

This is a sanitized, non-billable acceptance note for the frozen local
`0.2.0-rc.1` archive. The disposable API returned only `/me`; no Chat request
was sent and no credential was real.

Fresh-prefix executable:

```text
/private/tmp/swico-final-prefix.a9QI2D/bin/swico
```

The real PTY transcript showed:

```text
╭──────────────────────────────────────────────────────────────────╮
│ Swico 0.2.0-rc.1 · Swico Lite                                    │
│ <workspace> · main                                                │
╰──────────────────────────────────────────────────────────────────╯
· Ready · Enter sends · Ctrl+J inserts a newline · Ctrl+C cancels
> Ask Swico anything…
```

`/exit` was typed into that installed process; it returned exit 0 and emitted
the bracketed-paste/cursor cleanup controls. The renderer's resize callback
and width-bounded wrapping are covered by the rich UI tests; the captured PTY
run was the normal desktop width. Narrow/wide visual review remains a host
terminal presentation check, not a paid-Chat or agent-readiness claim.
