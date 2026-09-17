# Swico Cloud control plane and runner boundary

The repository now contains a durable, owner-scoped Cloud job control plane
and a separate `cloud_runner/` service boundary. Creating a queued job does
not execute repository code. The FastAPI process never accepts a host path,
end-user refresh token, or arbitrary command for local execution.

The runner service includes an opt-in E2B executor and is fail-closed until
its selected runtime passes hostile verification for workspace confinement,
symlink escape, network and environment isolation, process cleanup, quotas,
and capability replay. A plain process or shared temporary directory is not
sufficient. The runner must provide fresh signed isolation evidence; the
legacy readiness boolean is ignored. Until then,
`SWICO_CLI_CLOUD_AGENT_ENABLED=false` remains the only production setting.

When the runner service is genuinely ready, the control-plane lifecycle is:

`queued → dispatching → starting → running → waiting_for_approval → cancelling → completed|failed|cancelled|expired`

Requests are owner-scoped and idempotent by `(user, request_id)`. Events are
bounded and safe for CLI polling and the website `/tasks` surface. The next
runner milestone must add authenticated claim/lease/heartbeat, snapshot
materialization with the bounded manifest, cancellation acknowledgement,
bounded results/diffs, and cleanup. It must not run in the API worker. The
current `cloud_runner/e2b_executor.py` is a deployable integration point, not
live acceptance evidence.

Readiness is separate from public Chat:

```sh
python scripts/swico_cli_release_check.py --pretty --public
python scripts/swico_cli_release_check.py --pretty --cloud-pilot
```

The cloud-pilot check must remain red unless the runner URL, credential
configuration, fresh authenticated attestation, current schema, and
production-safe auth settings are all present. It is not a deployment command.
