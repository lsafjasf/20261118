"""生成单文件、离线可用的 HTML 逐帧对比查看器。

图像以 base64 内嵌，不依赖外部服务器或 CDN；功能：
- 场景与场序切换、逐帧步进/滑块/自动播放/键盘左右键；
- 奇数场（顶场）、偶数场（底场）与三个策略合成结果并排；
- 叠加梳齿/重影高亮、显示客观指标、处理耗时与推荐策略。
"""

import base64
import json
import os

import numpy as np
from PIL import Image

from .io_utils import read_json
from .fields import split_fields

THUMB_WIDTH = 300


def _thumbnail_data_uri(path: str) -> str:
    image = Image.open(path).convert("RGB")
    ratio = THUMB_WIDTH / image.width
    thumb = image.resize((THUMB_WIDTH, int(image.height * ratio)), Image.BILINEAR)
    from io import BytesIO

    buffer = BytesIO()
    thumb.save(buffer, format="PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _embed_sequence(directory: str, limit: int) -> list[str]:
    names = sorted(name for name in os.listdir(directory) if name.endswith(".png"))
    uris = []
    for name in names[:limit]:
        uris.append(_thumbnail_data_uri(os.path.join(directory, name)))
    return uris


def _embed_field(directory: str, limit: int, which: str) -> list[str]:
    """从隔行输入帧提取顶场/底场并放大为整帧高度后内嵌。"""
    names = sorted(name for name in os.listdir(directory) if name.endswith(".png"))
    uris = []
    from io import BytesIO

    for name in names[:limit]:
        image = Image.open(os.path.join(directory, name)).convert("RGB")
        top, bottom = split_fields(np.asarray(image))
        field = top if which == "top" else bottom
        field_image = Image.fromarray(field, mode="RGB").resize(
            (image.width, image.height), Image.NEAREST
        )
        ratio = THUMB_WIDTH / field_image.width
        thumb = field_image.resize(
            (THUMB_WIDTH, int(field_image.height * ratio)), Image.NEAREST
        )
        buffer = BytesIO()
        thumb.save(buffer, format="PNG", optimize=True)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        uris.append(f"data:image/png;base64,{encoded}")
    return uris


def build_viewer(output_root: str, viewer_path: str, limit: int = 24) -> str:
    """汇总各场景 report.json 与导出帧，生成单文件 HTML。"""
    scenes = []
    for entry in sorted(os.listdir(output_root)):
        scene_dir = os.path.join(output_root, entry)
        report_path = os.path.join(scene_dir, "report.json")
        if not os.path.isfile(report_path):
            continue
        report = read_json(report_path)
        payload = {
            "id": entry,
            "meta": {
                "field_order": report["field_order"],
                "source_fps": report["source_fps"],
                "output_fps": report["output_fps"],
                "size": report["frame_size"],
            },
            "selection": report["selection"],
            "timing": report["timing"],
            "sequences": {
                "input": _embed_sequence(
                    os.path.join(scene_dir, "input"), limit
                ),
                "top_field": _embed_field(
                    os.path.join(scene_dir, "input"), limit, "top"
                ),
                "bottom_field": _embed_field(
                    os.path.join(scene_dir, "input"), limit, "bottom"
                ),
                "reference": _embed_sequence(
                    os.path.join(scene_dir, "reference"), limit
                ),
                "bob": _embed_sequence(os.path.join(scene_dir, "bob"), limit),
                "weave": _embed_sequence(os.path.join(scene_dir, "weave"), limit),
                "adaptive": _embed_sequence(
                    os.path.join(scene_dir, "adaptive"), limit
                ),
            },
        }
        scenes.append(payload)

    template_path = os.path.join(os.path.dirname(__file__), "viewer_template.html")
    with open(template_path, "r", encoding="utf-8") as handle:
        template = handle.read()
    data_json = json.dumps(scenes, ensure_ascii=False)
    html = template.replace("__SCENE_DATA__", data_json)
    os.makedirs(os.path.dirname(viewer_path) or ".", exist_ok=True)
    with open(viewer_path, "w", encoding="utf-8") as handle:
        handle.write(html)
    return viewer_path
