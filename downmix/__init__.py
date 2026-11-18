"""5.1 -> stereo downmix toolkit (pure standard library).

Channel order follows the SMPTE/ITU layout used by WAVEFORMATEXTENSIBLE:
L, R, C, LFE, Ls, Rs.
"""

from .engine import CHANNELS, MUTED, DownmixConfig, downmix
from .meters import ChannelStats, analyze, channel_stats
from .wavio import read_wav, write_wav

__all__ = [
    "CHANNELS",
    "MUTED",
    "DownmixConfig",
    "downmix",
    "ChannelStats",
    "analyze",
    "channel_stats",
    "read_wav",
    "write_wav",
]
