# Swico Cloud runner

This is a separate deployable boundary, not a worker embedded in FastAPI.
The default service is fail-closed: `/health` reports `ready=false` until the
selected native/container executor has passed hostile verification. The
runner accepts only a short-lived, HMAC-bound capability for one job and never
receives an end-user refresh token or Firebase Admin credential.

The production architecture is:

`API/auth/billing → durable DB queue → runner claim/lease → isolated ephemeral workspace → bounded events/artifacts → cleanup`

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
validated snapshot bytes, runs a preinstalled `SWICO_RUNNER_AGENT_COMMAND`,
and kills the sandbox in a `finally` path. It is not production-ready merely
because the SDK is installed: native hostile acceptance, controller
capability exchange, snapshot upload, billing reconciliation, and fresh signed
runner evidence are still required before enabling Cloud. No user refresh
token or global provider key is passed to the job.
