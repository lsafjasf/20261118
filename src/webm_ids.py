"""Matroska/WebM element IDs used by the rebuilder (subset of the spec)."""

# Top level / structural
EBML_HEADER = 0x1A45DFA3
SEGMENT = 0x18538067
SEEK_HEAD = 0x114D9B74
INFO = 0x1549A966
TRACKS = 0x1654AE6B
CLUSTER = 0x1F43B675
CUES = 0x1C53BB6B

# Info
TIMESTAMP_SCALE = 0x2AD7B1
DURATION = 0x4489
MUXING_APP = 0x4D80
WRITING_APP = 0x5741

# Tracks
TRACK_ENTRY = 0xAE
TRACK_NUMBER = 0xD7
TRACK_UID = 0x73C5
TRACK_TYPE = 0x83
CODEC_ID = 0x86
DEFAULT_DURATION = 0x23E383
PIXEL_WIDTH = 0xB0
PIXEL_HEIGHT = 0xBA

# Cluster
CLUSTER_TIMECODE = 0xE7
SIMPLE_BLOCK = 0xA3
BLOCK_GROUP = 0xA0
BLOCK = 0xA1

# Cues
CUE_POINT = 0xBB
CUE_TIME = 0xB3
CUE_TRACK_POSITIONS = 0xB7
CUE_TRACK = 0xF7
CUE_CLUSTER_POS = 0xF1
CUE_REL_POS = 0xF0

# Track types (Matroska spec)
TRACK_TYPE_VIDEO = 1
TRACK_TYPE_AUDIO = 2

# Block header lacing values
LACING_NONE = 0
LACING_XIPH = 1
LACING_EBML = 3
LACING_FIXED = 2


def name_for(elem_id):
    for key, value in globals().items():
        if key.isupper() and value == elem_id:
            return key
    return f"0x{elem_id:X}"
