"""双字幕（主字幕 + 翻译字幕）空间冲突检测与排版工具。

模块划分：
- model:    画布、安全边距、字幕轨、字幕块等数据模型
- srt:      SRT 字幕解析
- metrics:  按字号/阅读方向/最长行宽估算占用矩形
- conflict: 时间轴重叠扫描 + 矩形空间冲突判定
- solver:   上下换位 / 短暂错峰建议（不删除任何字幕）
- report:   冲突时间段与最终布局的文本 / JSON 报告
"""

from .model import Canvas, Cue, Rect, SafeMargin, Slot, Track, TrackStyle
from .conflict import ConflictPeriod, detect_conflicts
from .solver import LayoutPlan, resolve_layout

__all__ = [
    "Canvas",
    "Cue",
    "Rect",
    "SafeMargin",
    "Slot",
    "Track",
    "TrackStyle",
    "ConflictPeriod",
    "detect_conflicts",
    "LayoutPlan",
    "resolve_layout",
]
