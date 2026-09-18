"""Public template diagnostics: fixed codes/actions only, never native stderr."""

ACTIONS = {
    "template_cfr_required": "Use a reviewed master with a valid nominal rational frame rate; inspect it locally.",
    "template_vfr_unsupported": "Supply an explicitly prepared stable-CFR master. Automatic VFR retiming is not supported.",
    "template_odd_dimensions": "Prepare an even-width/even-height master explicitly; automatic resizing is not performed.",
    "template_resolution_unsupported": "Use a master with both dimensions between 64 and 1920 pixels.",
    "template_duration_unsupported": "Use a master between 1 and 30 seconds.",
    "template_fps_unsupported": "Use a finite rational frame rate between 1 and 60 fps.",
    "template_timing_invalid": "Inspect the source locally for missing, repeated, reversed or inconsistent timestamps; supply a corrected master.",
    "template_frames_unsupported": "Use a complete master with 2 to 1800 decoded frames.",
    "template_existing": "The template already exists. Inspect/archive it explicitly; it was not replaced.",
    "template_probe_failed": "Run tools status and templates inspect locally; check that the input is a readable, supported local video.",
    "template_source_invalid": "Select an existing local regular media file, not a URL or device.",
    "template_size_unsupported": "Use a template master no larger than 200 MiB.",
    "template_streams_unsupported": "Use a single-video master with at most one audio stream.",
    "template_audio_unsupported": "For normalization, supply compatible AAC, MP3 or ALAC audio; automatic audio conversion is not performed.",
    "template_output_existing": "Choose a new output filename; existing files and symlinks are never overwritten.",
    "template_output_invalid": "Choose a new .mp4 filename in an existing local directory.",
    "template_normalize_failed": "Check tools status and source inspection. No final output was published; original input is unchanged.",
    "template_import_failed": "Check private storage permissions/free space and retry. No completed template was published.",
    "template_operation_failed": "Check local tools, template rights and reviewed track records for this operation; no approval is implied.",
    "template_rights_missing": "Use templates rights add with genuine licence, permission and the three explicit video/audio rights confirmations.",
    "template_rights_unknown": "Use one of the two imported template IDs: couple-01 or couple-02.",
    "template_rights_manifest_missing": "The requested template is not completely imported; import a reviewed local master first.",
    "template_rights_evidence_failed": "Select genuine local rights documents and retry. Document integrity is not legal approval.",
    "template_rights_update_failed": "No template rights update was published; inspect private storage and retry.",
    "evidence_source_missing": "Choose an existing local regular evidence file; the command never creates legal evidence.",
    "evidence_source_symlink": "Choose the original regular evidence file, not a symlink or alias.",
    "evidence_source_not_regular": "Choose a regular local evidence file, not a directory, device or pipe.",
    "evidence_source_size_invalid": "Use a non-trivial evidence document no larger than the bounded local evidence limit.",
    "evidence_source_changed": "The evidence file changed while it was copied; select it again.",
    "evidence_source_empty": "The evidence document is empty or trivial; supply genuine evidence.",
    "evidence_scope_invalid": "The private evidence scope is invalid; use the supported asset or template command.",
    "evidence_metadata_invalid": "Provide a bounded reviewer name or role without control characters.",
    "evidence_date_invalid": "Use a real review date in YYYY-MM-DD format.",
    "evidence_manifest_invalid": "The private evidence manifest is not a regular file; stop and inspect storage.",
    "evidence_backup_failed": "The private backup could not be created; no evidence update was published.",
    "evidence_store_failed": "The evidence copy could not be published privately; no manifest update was published.",
    "evidence_destination_conflict": "A private evidence hash destination conflicts with different bytes; stop and inspect storage.",
    "model_asset_unknown": "Choose an asset listed by models evidence status, including code_review.",
    "model_permission_required": "This asset requires a separate genuine permission document as well as licence evidence.",
    "restricted_permission_required": "Restricted pretrained weights cannot use applicable_licence as a permission bypass; supply actual right-holder permission evidence.",
    "model_evidence_update_failed": "No model evidence update was published; inspect private storage and retry.",
    "provenance_asset_unknown": "Choose one fixed model asset listed by models provenance status.",
    "provenance_confirmation_required": "Technical hash recording requires the explicit --confirm-technical-hash acknowledgement.",
    "provenance_fetch_failed": "The fixed upstream technical hash sidecar could not be safely retrieved; no model bytes were downloaded.",
    "provenance_response_invalid": "The fixed upstream response was not a bounded SHA-256 sidecar; no model bytes were downloaded.",
    "model_expected_hash_missing": "Use the fixed FaceFusion .hash sidecar provenance command; technical hashes do not grant commercial permission.",
    "model_bytes_not_installed": "After the independent rights and technical audit passes, run the explicit quality-cpu model install.",
    "model_bytes_hash_mismatch": "Stop and investigate installed model bytes; do not substitute or automatically redownload a reviewed asset.",
    "model_source_unreviewed": "Review the fixed pinned FaceFusion source before any model installation.",
    "reviewer_missing": "Provide a real accountable reviewer name or role.",
    "reviewed_at_missing": "Provide the real review date in YYYY-MM-DD format.",
    "permission_evidence_missing": "Provide genuine permission evidence with the local evidence command.",
    "licence_evidence_missing": "Provide genuine licence evidence with the local evidence command.",
}


class TemplateError(ValueError):
    def __init__(self, code):
        self.code = code if code in ACTIONS else "template_operation_failed"
        super().__init__(self.code)

    @property
    def action(self):
        return ACTIONS[self.code]
