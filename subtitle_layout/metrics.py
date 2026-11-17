"""占用矩形估算。

估算依据（无字体文件时的保守模型）：
- 横排文字按字符类别给前进宽度：CJK/假名/谚文/全角字符约 1.0em，
  其它文字约 0.55em，空格约 0.28em；行高 1.15em。
- 最长行宽超过 ``max_width_ratio`` 倍安全区宽度时自动折行；
  CJK 按字符断行，拉丁词按单词断行。
- 竖排（TTB）按列排布，列从右向左；列高受同一比例上限约束。
- 文字四周计入背景描边留白（pad_x/pad_y）。
- 横排块在安全区内水平居中；槽位决定纵向锚点（顶部/底部）。
"""

from __future__ import annotations

from .model import Canvas, Cue, ReadingDirection, Rect, Slot, Track

LINE_HEIGHT_RATIO = 1.15
ADVANCE_CJK = 1.0
ADVANCE_LATIN = 0.55
ADVANCE_SPACE = 0.28


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x1100 <= code <= 0x115F  # 谚文兼容字母
        or 0x2E80 <= code <= 0x9FFF  # CJK 部首/汉字/假名
        or 0xA960 <= code <= 0xA97F
        or 0xAC00 <= code <= 0xD7A3  # 谚文音节
        or 0xF900 <= code <= 0xFAFF  # CJK 兼容表意文字
        or 0xFE30 <= code <= 0xFE4F  # CJK 兼容标点
        or 0xFF00 <= code <= 0xFFEF  # 全角字符
        or 0x20000 <= code <= 0x3FFFF
    )


def char_advance(ch: str, font_size: int) -> float:
    if ch.isspace():
        return font_size * ADVANCE_SPACE
    if _is_cjk(ch):
        return font_size * ADVANCE_CJK
    return font_size * ADVANCE_LATIN


def text_width(text: str, font_size: int) -> float:
    return sum(char_advance(ch, font_size) for ch in text)


def _wrap_horizontal(
    lines: list[str], font_size: int, max_text_width: float
) -> list[str]:
    """横排折行：CJK 可在任意字符间断行，拉丁文字按单词断行。"""
    wrapped: list[str] = []
    for source_line in lines:
        tokens: list[str] = []
        buffer = ""
        for ch in source_line:
            if ch.isspace() or _is_cjk(ch):
                if buffer:
                    tokens.append(buffer)
                    buffer = ""
                tokens.append(ch)
            else:
                buffer += ch
        if buffer:
            tokens.append(buffer)

        current = ""
        current_width = 0.0
        for token in tokens:
            token_width = text_width(token, font_size)
            if token.isspace() and not current:
                continue  # 行首空格丢弃
            if current and current_width + token_width > max_text_width:
                wrapped.append(current.rstrip())
                current = ""
                current_width = 0.0
                if token.isspace():
                    continue
            current += token
            current_width += token_width
        if current.strip():
            wrapped.append(current.rstrip())
    return wrapped or [""]


def _wrap_vertical(
    lines: list[str], font_size: int, line_height: float, max_column_height: float
) -> list[str]:
    """竖排折列：每个源行拆成若干列，逐字填充，列满换列。"""
    columns: list[str] = []
    for source_line in lines:
        column = ""
        column_height = 0.0
        for ch in source_line:
            if column and column_height + line_height > max_column_height:
                columns.append(column)
                column = ""
                column_height = 0.0
            column += ch
            column_height += line_height
        if column:
            columns.append(column)
    return columns or [""]


def block_dimensions(cue: Cue, track: Track, canvas: Canvas) -> tuple[float, float, list[str]]:
    """返回字幕块的（宽, 高, 折行/折列后的文本行）。"""
    style = track.style
    line_height = style.font_size * LINE_HEIGHT_RATIO
    max_text_width = canvas.content_width * style.max_width_ratio - 2 * style.pad_x

    if track.direction.value == "ttb":
        max_column_height = (
            canvas.content_height * style.max_width_ratio - 2 * style.pad_y
        )
        columns = _wrap_vertical(cue.lines, style.font_size, line_height, max_column_height)
        longest = max(len(column) for column in columns)
        width = (
            len(columns) * style.font_size
            + (len(columns) - 1) * style.line_gap
            + 2 * style.pad_x
        )
        height = longest * line_height + 2 * style.pad_y
        return width, height, columns

    wrapped = _wrap_horizontal(cue.lines, style.font_size, max_text_width)
    longest_line = max(text_width(line, style.font_size) for line in wrapped)
    width = longest_line + 2 * style.pad_x
    height = (
        len(wrapped) * line_height
        + (len(wrapped) - 1) * style.line_gap
        + 2 * style.pad_y
    )
    return width, height, wrapped


def place_block(
    canvas: Canvas,
    slot: Slot,
    width: float,
    height: float,
    slot_gap: float = 24.0,
    direction: ReadingDirection = ReadingDirection.LTR,
) -> Rect:
    """单块入槽：纵向贴对应安全区边沿，水平在安全区内居中。"""
    x0 = canvas.safe_margin.left + (canvas.content_width - width) / 2
    x1 = x0 + width
    if slot is Slot.TOP:
        y0 = float(canvas.content_top)
        y1 = y0 + height
    else:
        y1 = float(canvas.content_bottom)
        y0 = y1 - height
    return Rect(x0, y0, x1, y1)


def place_stacked(
    canvas: Canvas,
    anchor: Slot,
    blocks: list[tuple[float, float]],
    slot_gap: float = 24.0,
    directions: list[ReadingDirection] | None = None,
) -> list[Rect]:
    """按堆叠顺序摆放一组字幕块。

    ``blocks`` 顺序即从锚点边沿向外的排布顺序：
    - anchor=BOTTOM：第一块贴安全区下沿，后续块依次向上，块间留 slot_gap；
    - anchor=TOP：第一块贴安全区上沿，后续块依次向下。
    """
    rects: list[Rect] = []
    directions = directions or [ReadingDirection.LTR] * len(blocks)
    if anchor is Slot.BOTTOM:
        next_top = float(canvas.content_bottom)
        for (width, height), direction in zip(blocks, directions):
            x0 = _horizontal_origin(canvas, width, direction)
            y1 = next_top
            y0 = y1 - height
            rects.append(Rect(x0, y0, x0 + width, y1))
            next_top = y0 - slot_gap
    else:
        next_bottom = float(canvas.content_top)
        for (width, height), direction in zip(blocks, directions):
            x0 = _horizontal_origin(canvas, width, direction)
            y0 = next_bottom
            y1 = y0 + height
            rects.append(Rect(x0, y0, x0 + width, y1))
            next_bottom = y1 + slot_gap
    return rects


def _horizontal_origin(
    canvas: Canvas, width: float, direction: ReadingDirection
) -> float:
    """水平起点：横排（LTR/RTL）与竖排（TTB）默认都在安全区内水平居中。

    阅读方向主要影响文字内部走向与折行；两条字幕同屏时水平居中可避免
    左右错位造成的额外拥挤，是双字幕场景的保守默认。RTL 的靠右需求由
    TrackStyle 扩展时再开放。
    """
    return canvas.safe_margin.left + (canvas.content_width - width) / 2


def cue_rect(
    cue: Cue,
    track: Track,
    canvas: Canvas,
    slot: Slot,
    slot_gap: float = 24.0,
) -> Rect:
    width, height, _ = block_dimensions(cue, track, canvas)
    return place_block(
        canvas, slot, width, height, slot_gap, direction=track.direction
    )


def safe_area_overflow(rect: Rect, canvas: Canvas) -> list[str]:
    """返回矩形超出安全区的边名列表，空列表表示完全在安全区内。"""
    edges: list[str] = []
    if rect.x0 < canvas.safe_margin.left:
        edges.append("left")
    if rect.x1 > canvas.width - canvas.safe_margin.right:
        edges.append("right")
    if rect.y0 < canvas.content_top:
        edges.append("top")
    if rect.y1 > canvas.content_bottom:
        edges.append("bottom")
    return edges
