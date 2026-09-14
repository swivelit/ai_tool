# Third-party notices

The Swico CLI does not copy third-party source into its first-party `dist/`
output. Runtime dependencies are installed separately by npm, and their own
package license files remain authoritative. This index records the direct
runtime dependencies resolved by `package-lock.json` for this release:

| Package | Resolved version | License metadata |
|---|---:|---|
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `@napi-rs/keyring` | 2.0.0 | MIT |
| `ajv` | 8.20.0 | MIT |
| `zod` | 3.25.76 | MIT |

The lockfile also records transitive packages and their license metadata. They
are not first-party Swico code and are not relicensed by `cli/LICENSE`.
Distribution tools must preserve the dependency package metadata and license
files installed for this lockfile. This short index is not an ownership or
license-compliance audit of the dependency ecosystem.
