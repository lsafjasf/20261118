"""iXML chunk parsing (subset relevant to BWF cross-checks)."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

from .riff import Chunk

# iXML elements mirrored from / cross-checked against other chunks
TRACKED_ELEMENTS = [
    "IXML_VERSION", "PROJECT", "SCENE", "TAKE", "TAPE", "NOTE",
    "BEXT/BWF_DESCRIPTION", "BEXT/BWF_ORIGINATOR",
    "BEXT/BWF_ORIGINATOR_REFERENCE", "BEXT/BWF_ORIGINATION_DATE",
    "BEXT/BWF_ORIGINATION_TIME", "BEXT/BWF_TIME_REFERENCE_LOW",
    "BEXT/BWF_TIME_REFERENCE_HIGH", "BEXT/BWF_VERSION",
    "FILE_SET/FAMILY_UID", "FILE_SET/TOTAL_FILES",
]


@dataclass
class IxmlInfo:
    chunk: Chunk
    values: dict[str, str] = field(default_factory=dict)

    @property
    def time_reference(self) -> int | None:
        lo = self.values.get("BEXT/BWF_TIME_REFERENCE_LOW")
        hi = self.values.get("BEXT/BWF_TIME_REFERENCE_HIGH")
        if lo is None and hi is None:
            return None
        try:
            return (int(hi or 0) << 32) | (int(lo or 0) & 0xFFFFFFFF)
        except ValueError:
            return None

    def element_offset(self, tag_path: str) -> int | None:
        """Approximate absolute offset of the element's text in the file."""
        tag = tag_path.split("/")[-1]
        payload = self.chunk.payload
        m = re.search(rb"<" + tag.encode() + rb"[^>]*>", payload)
        if not m:
            return None
        return self.chunk.data_offset + m.end()


def parse_ixml(chunk: Chunk) -> IxmlInfo:
    root = ET.fromstring(chunk.payload.decode("utf-8", errors="replace"))
    values: dict[str, str] = {}
    for path in TRACKED_ELEMENTS:
        node = root.find(path)
        if node is not None and node.text is not None:
            values[path] = node.text.strip()
    return IxmlInfo(chunk, values)


def set_ixml_value(chunk: Chunk, tag_path: str, value: str) -> bytes:
    """Return a new iXML payload with one simple element's text replaced."""
    text = chunk.payload.decode("utf-8")
    tag = tag_path.split("/")[-1]
    pattern = re.compile(
        r"(<" + re.escape(tag) + r"(?:\s[^>]*)?>)(.*?)(</" + re.escape(tag) + r">)",
        re.DOTALL,
    )
    new_text, count = pattern.subn(lambda m: m.group(1) + value + m.group(3),
                                   text, count=1)
    if count == 0:
        raise KeyError(f"iXML element <{tag}> not found")
    return new_text.encode("utf-8")
