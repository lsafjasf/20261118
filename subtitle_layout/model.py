"""字幕排版的数据模型。

所有几何坐标均以像素为单位，原点 (0, 0) 在画面左上角，x 向右、y 向下。
时间统一使用毫秒（int）表示。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class ReadingDirection(str, Enum):
    """阅读方向。"""

    LTR = "ltr"  # 从左到右（拉丁、西里尔等横排文字）
    RTL = "rtl"  # 从右到左（阿拉伯语、希伯来语等横排文字）
    TTB = "ttb"  # 从上到下（中文/日文竖排，列从右向左排列）


class Slot(str, Enum):
    """字幕在画面中的纵向槽位。"""

    TOP = "top"
    BOTTOM = "bottom"


@dataclass(frozen=True)
class Rect:
    """轴对齐占用矩形。"""

    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def intersects(self, other: Rect) -> bool:
        return not (
            self.x1 <= other.x0
            or other.x1 <= self.x0
            or self.y1 <= other.y0
            or other.y1 <= self.y0
        )

    def intersection(self, other: Rect) -> Rect | None:
        if not self.intersects(other):
            return None
        return Rect(
            max(self.x0, other.x0),
            max(self.y0, other.y0),
            min(self.x1, other.x1),
            min(self.y1, other.y1),
        )


@dataclass(frozen=True)
class SafeMargin:
    """画面安全边距（像素），字幕矩形不得侵入。"""

    top: int
    right: int
    bottom: int
    left: int


@dataclass(frozen=True)
class Canvas:
    """视频画面与安全区。"""

    width: int = 1920
    height: int = 1080
    safe_margin: SafeMargin = SafeMargin(top=80, right=96, bottom=120, left=96)

    @property
    def content_top(self) -> int:
        return self.safe_margin.top

    @property
    def content_bottom(self) -> int:
        return self.height - self.safe_margin.bottom

    @property
    def content_width(self) -> int:
        return self.width - self.safe_margin.left - self.safe_margin.right

    @property
    def content_height(self) -> int:
        return self.content_bottom - self.content_top


@dataclass(frozen=True)
class Cue:
    """单条字幕：时间区间（毫秒）与文本（可含多行）。"""

    cue_id: str
    start_ms: int
    end_ms: int
    text: str

    @property
    def lines(self) -> list[str]:
        return [line for line in self.text.split("\n") if line.strip()]


@dataclass(frozen=True)
class TrackStyle:
    """一条字幕轨的排版样式。

    font_size:  字号（像素，即 em 方块高度）
    line_gap:   相邻行 / 列之间的额外间距（像素）
    pad_x/pad_y: 文字四周的背景描边留白（像素，计入占用矩形）
    max_width_ratio: 最长行宽相对安全区宽度的上限，超出则折行
    """

    font_size: int = 48
    line_gap: int = 8
    pad_x: int = 16
    pad_y: int = 12
    max_width_ratio: float = 0.82


@dataclass
class Track:
    """一条字幕轨（主字幕或翻译字幕）。"""

    name: str
    language: str
    direction: ReadingDirection
    style: TrackStyle = field(default_factory=TrackStyle)
    cues: list[Cue] = field(default_factory=list)

    def cue_at(self, time_ms: int) -> Cue | None:
        for cue in self.cues:
            if cue.start_ms <= time_ms < cue.end_ms:
                return cue
        return None
