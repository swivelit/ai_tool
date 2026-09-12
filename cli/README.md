# @swiveltechnologies/swico

Swico CLI is a third client for existing Swico accounts. The terminal client
uses the existing Swico account and Chat billing bucket.
It does not accept provider keys or expose provider/model identifiers. The
server selects the public tier and enforces its normal quota and reservation
rules.

## Install

Customers do not need an npm account to download the public package:

```sh
npm install -g @swiveltechnologies/swico
swico login
swico
```

The production API is built in as `https://ai-tool-rrau.onrender.com`; browser
approval remains on the server-controlled `https://swico.in` origin. Customers
do not need Python, this repository, TypeScript, or provider keys.

An earlier unavailable scope was `@swico/swico`. Remove only that old package
before installing the official scope so both packages do not compete for
`swico`; this does not remove Swico credentials:

```sh
npm uninstall -g @swico/swico
npm install -g @swiveltechnologies/swico
```

On Windows use `npm.cmd` and `swico.cmd` where command shims require them.

## Development

```sh
npm --prefix cli ci
npm --prefix cli run build
npm --prefix cli link
swico --help
```

For a local release artifact without publishing or an AI request, run:

```sh
cd cli
npm run release:check
```

It derives the tarball filename from `npm pack --json`, verifies the manifest
and compiled entrypoint, prints a SHA-256, and installs it into a clean
temporary npm prefix before running help/version/doctor outside this checkout.
Pass `--keep-artifact` when an operator needs the checked tarball for a later
publish command; the default check removes its temporary artifact.

Set `SWICO_API_BASE_URL` only for an approved HTTPS development endpoint.
Production endpoints must use HTTPS. On supported desktop installations,
credentials use the native OS store through `@napi-rs/keyring`: macOS
Keychain, Windows Credential Manager, or Linux Secret Service. The package
ships prebuilt native bindings for supported Node/OS/architecture triples, so
Rust is not required for an ordinary installation. If the native store is
unavailable, the CLI fails closed; choose the explicit protected-file fallback
`SWICO_CLI_CREDENTIAL_FILE` or the deliberately non-persistent `--memory-only`
mode. These choices are reported accurately and are never made implicitly.

`swico login` opens `/cli/authorize`, displays a short-lived human code, and
polls at the server-advertised interval. Browser approval is explicit.

The bounded agent asks for workspace trust before sending selected content to
Swico, requires approval for every edit/command, confines files to the chosen
root, rejects secrets/symlinks/binaries, and runs commands with user
permissions. It is not an OS sandbox or full Codex replacement.

The initial public Chat release keeps `SWICO_CLI_AGENT_ENABLED=false` until
durable budgeting, cancellation/recovery, sensitive-path and local-side-effect
recovery gates are verified. `swico login --agent` requests the additional
scope but does not bypass the server gate or tier eligibility.
