# Swico Cloud runner

This is a separate deployable boundary, not a worker embedded in FastAPI.
The default service is fail-closed: `/health` reports `ready=false` until the
selected native/container executor has passed hostile verification. The
runner accepts only a short-lived, HMAC-bound capability for one job and never
receives an end-user refresh token or Firebase Admin credential.

The production architecture is:

`API/auth/billing → durable DB queue → runner claim/lease → isolated ephemeral workspace → bounded events/artifacts → cleanup`

The deployable controller is `cloud_runner.controller`. It polls the durable
claim endpoint, forwards task-only jobs to the private runner, renews the API
lease, and records a bounded terminal result. It does not read or execute a
repository on its own host. Start it separately with:

```sh
python -m cloud_runner.controller
```

The controller executes `task_only` jobs and forwards explicitly uploaded
`workspace_snapshot` bytes. A manifest or a host path is never interpreted as
repository contents; missing snapshot bytes fail closed with
`snapshot_transfer_unavailable`.

Before enabling `SWICO_CLI_CLOUD_AGENT_ENABLED`, deploy this service privately,
configure the matching backend runner URL and shared secret, complete native
filesystem/symlink/network/environment/process hostile probes, and provide a
short-lived signed `SWICO_RUNNER_ISOLATION_ATTESTATION`. The legacy readiness
boolean is ignored. A plain shared temp directory or ordinary child process is
not an isolation backend and must not be marked ready.

Local start for protocol/health development only:

```sh
uvicorn cloud_runner.app:app --host 127.0.0.1 --port 8790
```

The opt-in `e2b_executor.py` uses the pinned E2B Python SDK 2.6.1. It creates
one secure sandbox per job with internet disabled, writes only controller-
validated snapshot bytes, and invokes the source-controlled
`cloud_runner.swico_cloud_agent` action protocol. There is no operator-supplied
agent command. The trusted controller must provide a bounded structured plan;
an empty plan fails explicitly and is never reported as a successful coding
task. Native hostile acceptance, controller capability exchange, snapshot
upload, billing reconciliation, and fresh signed runner evidence are still
required before enabling Cloud. No user refresh token or global provider key
is passed to the job.
