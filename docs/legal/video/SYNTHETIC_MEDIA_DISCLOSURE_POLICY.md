# Synthetic-media disclosure and provenance

Every generated template-video MP4 must carry:

- a prominent visible `AI-EDITED / SYNTHETIC MEDIA - SWICO` disclosure; and
- an opaque `swico-v1-...` provenance identifier in the MP4 metadata where the
  container preserves the metadata.

The identifier is intentionally non-sensitive and does not contain an email,
face hash, source filename or URL. It helps correlate an output with bounded
internal records; it is not a cryptographic authenticity guarantee or a legal
rights grant. The service does not expose a suppression/removal option.

The worker must verify both the required upload headers and the output media
before accepting a result. A downloaded or re-encoded copy may lose metadata,
so the visible disclosure remains the primary user-facing requirement.
