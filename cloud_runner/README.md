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
filesystem/symlink/network/environment/process hostile probes, and set the
backend handshake only from an authenticated operator/health integration. A
plain shared temp directory or ordinary child process is not an isolation
backend and must not be marked ready.

Local start for protocol/health development only:

```sh
uvicorn cloud_runner.app:app --host 127.0.0.1 --port 8790
```
