"""PCM transient repair with pop/percussion discrimination."""

from .audio import Audio, read_wav, write_wav
from .detector import DetectionConfig, RepairResult, RepairInterval, repair_audio
from .metrics import ErrorMetrics, compare_audio
from .waveform import render_waveform_svg

__all__ = [
    "Audio",
    "DetectionConfig",
    "ErrorMetrics",
    "RepairInterval",
    "RepairResult",
    "compare_audio",
    "read_wav",
    "repair_audio",
    "render_waveform_svg",
    "write_wav",
]
