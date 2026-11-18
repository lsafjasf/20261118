"""Emit data/report.md summarizing confidence, grid error and BPM curves."""

import json
import os


MODE_LABEL = {
    "constant": "恒定 BPM",
    "ramp": "渐快 / 变速",
    "free": "自由演奏",
}


def main():
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    data = os.path.join(base, "data")
    lines = ["# 节拍分析报告", ""]
    summary = ["| 素材 | 模式 | 置信度 | 平均格点误差 (ms) | BPM 起 | BPM 止 |",
               "| --- | --- | --- | --- | --- | --- |"]
    details = []
    for name in ("constant", "accelerando", "free"):
        with open(os.path.join(data, f"{name}.analysis.json")) as f:
            a = json.load(f)
        bpm = [p[1] for p in a["bpm_curve"]]
        mae = "不适用" if a["mode"] == "free" else f"{a['mean_grid_error_ms']:.2f}"
        details += [
            f"## {name} — {MODE_LABEL[a['mode']]}",
            "",
            f"- 置信度: **{a['confidence'] * 100:.1f}%**",
            f"- 平均格点误差: **{mae} ms**"
            + ("" if a["mode"] == "free" else
               f"（中位 {a['median_grid_error_ms']:.2f} ms）"),
            f"- 网格点数: {len(a['grid'])}，起振点: {len(a['onsets'])}",
            f"- BPM 曲线点数: {len(a['bpm_curve'])}，"
            f"范围 {min(bpm):.2f} – {max(bpm):.2f}",
            f"- 诊断: 节奏稳定度 {a['diagnostics']['tempo_clarity']:.3f}，"
            f"周期可预测残差 {a['diagnostics']['period_predict_residual']:.4f}",
            "",
            "| # | 时间 (s) | BPM |",
            "| --- | --- | --- |",
        ]
        for i, (t, b) in enumerate(a["bpm_curve"]):
            lines.append(f"| {i + 1} | {t:.4f} | {b:.2f} |")
        lines.append("")
        summary.append(
            f"| {name} | {MODE_LABEL[a['mode']]} | "
            f"{a['confidence'] * 100:.1f}% | {mae} | "
            f"{bpm[0]:.2f} | {bpm[-1]:.2f} |"
        )
    lines = ["# 节拍分析报告", "", "## 总览", ""] + summary + [""] + details
    out = os.path.join(data, "report.md")
    with open(out, "w") as f:
        f.write("\n".join(lines))
    print("written", out)


if __name__ == "__main__":
    main()
