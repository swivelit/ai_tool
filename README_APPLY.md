# CLI-only MIT licensing kit

Prepared for the uploaded snapshot `282fec389a87b18de7ee4bd19097ea3516043346`.
This is a local proposal/patch, not an applied GitHub change or npm publication.
The user requested completion of the CLI licensing setup; the selected terms
are standard MIT for the CLI client only.

The patch adds cli/LICENSE, cli/LICENSE_SCOPE.md and a root LICENSE_SCOPE.md;
it updates CLI package metadata, lockfile root metadata and the CLI README.
It does not create a blanket repository LICENSE, edit hosted-service terms,
change runtime behavior, or license third-party work on anyone else's behalf.

From the repository root, review the patch first, then use:

```bash
git apply --check /absolute/path/to/swico-cli-mit.patch
git apply /absolute/path/to/swico-cli-mit.patch
```

If the checkout changed, reconcile the small changes manually instead of forcing
or overwriting newer source. The three standalone notice files are also included.
Rebuild and re-test the package after applying the patch. Inspect the actual
packed LICENSE, scope note, metadata and any required dependency notices before
publication. This kit is not a dependency copyright/compliance audit and does
not fix CI or implement the new terminal UI.

The copyright line uses the user's stated organization, Swivel Technologies,
and contributors. Preserve any existing specific third-party rightsholder
notices and verify the organization has authority over the first-party code.
