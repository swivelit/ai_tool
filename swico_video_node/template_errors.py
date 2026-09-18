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
}


class TemplateError(ValueError):
    def __init__(self, code):
        self.code = code if code in ACTIONS else "template_operation_failed"
        super().__init__(self.code)

    @property
    def action(self):
        return ACTIONS[self.code]
