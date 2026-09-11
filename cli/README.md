# Swico CLI

The terminal client uses the existing Swico account and Chat billing bucket.
It does not accept provider keys or expose provider/model identifiers. The
server selects the public tier and enforces its normal quota and reservation
rules.

## Install from this checkout

```sh
npm --prefix cli ci
npm --prefix cli run build
npm --prefix cli link
swico --help
```

For a tarball without the repository, run `npm --prefix cli pack --dry-run`,
then `npm install --global ./swiveltechnologies-swico-0.1.0.tgz` (or install
into a protected prefix). A future public release requires an owned npm scope;
the package is not published by this repository.

Set `SWICO_API_BASE_URL` for an approved development endpoint. Production
endpoints must use HTTPS. Credentials remain in memory by default. An explicit
`SWICO_CLI_CREDENTIAL_FILE` fallback is supported only when the user chooses
it and is written with restrictive permissions; a platform keychain adapter
may replace it.

`swico login` opens `/cli/authorize`, displays a short-lived human code, and
polls at the server-advertised interval. Browser approval is explicit.

The bounded agent asks for workspace trust before sending selected content to
Swico, requires approval for every edit/command, confines files to the chosen
root, rejects secrets/symlinks/binaries, and runs commands with user
permissions. It is not an OS sandbox or full Codex replacement.
