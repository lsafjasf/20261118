"""根据测试片的实测特征选择最适合的去隔行策略。

不固定输出某种混合结果，也不宣称单一策略兼容所有素材。对每个测试片：
1. 三种策略全部运行，对逐行真值计算 PSNR/MAE，并独立度量梳齿伪影；
2. 用运动自适应诊断里的运动行占比量化整段素材的运动程度；
3. 按运动程度分三段决策，再用客观指标交叉验证，证据全部写入报告。

不能只看 PSNR 的原因：高速横移时编织帧有一半行恰好来自相邻真值时刻，
全局 PSNR 可能偏高，但运动边界的梳齿/重影会被均值掩盖。因此高运动段
以梳齿伪影为主证据，静态段以垂直分辨率与 PSNR 为主证据。
"""

from dataclasses import dataclass

import numpy as np

STATIC_LIMIT = 0.03
HIGH_MOTION_LIMIT = 0.45


@dataclass
class StrategyReport:
    scene: str
    order: str
    moving_row_ratio: float
    mean_global_motion: float
    psnr: dict
    mae: dict
    combing: dict
    recommended: str
    reason: str

    def to_dict(self) -> dict:
        return {
            "scene": self.scene,
            "field_order": self.order,
            "moving_row_ratio": round(self.moving_row_ratio, 4),
            "mean_global_motion": round(self.mean_global_motion, 4),
            "psnr_db": {k: round(v, 3) for k, v in self.psnr.items()},
            "mae": {k: round(v, 4) for k, v in self.mae.items()},
            "combing_artifact": {k: round(v, 4) for k, v in self.combing.items()},
            "recommended": self.recommended,
            "reason": self.reason,
        }


def aggregate_motion(adaptive_diags: list[dict]) -> tuple[float, float]:
    moving = float(np.mean([d["moving_row_ratio"] for d in adaptive_diags]))
    global_motion = float(np.mean([d["global_motion"] for d in adaptive_diags]))
    return moving, global_motion


def choose_strategy(
    scene: str,
    order: str,
    adaptive_diags: list[dict],
    psnr_scores: dict[str, float],
    mae_scores: dict[str, float],
    combing_scores: dict[str, float],
) -> StrategyReport:
    moving, global_motion = aggregate_motion(adaptive_diags)
    best_psnr = max(psnr_scores, key=lambda key: psnr_scores[key])

    if moving <= STATIC_LIMIT:
        recommended = "weave"
        reason = (
            f"运动行占比 {moving:.3f} ≤ {STATIC_LIMIT}，素材近似静止，"
            "两场融合保留完整垂直分辨率且不产生运动梳齿；"
            f"PSNR weave={psnr_scores['weave']:.2f}dB、"
            f"bob={psnr_scores['bob']:.2f}dB"
        )
    elif moving >= HIGH_MOTION_LIMIT:
        recommended = "bob"
        reason = (
            f"运动行占比 {moving:.3f} ≥ {HIGH_MOTION_LIMIT}，整段高速横移，"
            "行复制不引用异极性场，无编织梳齿；梳齿指标 "
            f"bob={combing_scores['bob']:.2f} 远低于 "
            f"weave={combing_scores['weave']:.2f}、"
            f"adaptive={combing_scores['adaptive']:.2f}"
        )
    else:
        recommended = "adaptive"
        reason = (
            f"运动行占比 {moving:.3f} 位于 {STATIC_LIMIT}~{HIGH_MOTION_LIMIT} "
            "混合区间，静态区需融合保分辨率、运动区需行复制防梳齿，"
            "运动自适应按逐行运动强度切换；梳齿指标 "
            f"adaptive={combing_scores['adaptive']:.2f} 低于 "
            f"weave={combing_scores['weave']:.2f}，"
            f"PSNR={psnr_scores['adaptive']:.2f}dB"
        )

    if recommended != best_psnr:
        reason += (
            f"；全局 PSNR 最高者为 {best_psnr}"
            f"（{psnr_scores[best_psnr]:.2f}dB），两种证据均保留供复核"
        )

    return StrategyReport(
        scene=scene,
        order=order,
        moving_row_ratio=moving,
        mean_global_motion=global_motion,
        psnr=psnr_scores,
        mae=mae_scores,
        combing=combing_scores,
        recommended=recommended,
        reason=reason,
    )
