"""去隔行策略对比工具包。

三个策略：
- bob      简单行复制（Bob / line doubling）
- weave    两场融合（Weave / field merging）
- adaptive 运动自适应（Motion Adaptive，静态融合、运动行复制）
"""

from .fields import TOP, BOTTOM, split_fields, weave_fields, bob_upsample
from .methods import deinterlace_bob, deinterlace_weave, deinterlace_adaptive

__all__ = [
    "TOP",
    "BOTTOM",
    "split_fields",
    "weave_fields",
    "bob_upsample",
    "deinterlace_bob",
    "deinterlace_weave",
    "deinterlace_adaptive",
]
