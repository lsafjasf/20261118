# 镜头边界检测工具链

## 组成

- `make_test_video.py` — 生成含三种转场的测试片段 `test_transitions.mp4`
  （480 帧 @24fps）：硬切 @72、叠化 168-191、淡入淡出 264-311；
  另含两个干扰项：闪光灯单帧 @100、快速摇镜 380-399。真值见 `ground_truth.txt`。
- `shot_detector.py` — 检测器。对每帧计算 HSV 颜色直方图、Canny 边缘图、
  平均亮度；相邻帧差异 = 直方图 Bhattacharyya 距离 + 边缘 XOR 差异。
  - 硬切：孤立尖峰且单帧直方图距离 ≥ 0.6（鲁棒阈值 median+5·MAD）。
  - 渐变：直方图距离连续 ≥4 帧超阈（允许 1 帧缺口），且区间起止累计
    直方图漂移 ≥ 0.35。
  - 闪光灯排除：扰动 ≤2 帧且扰动前后直方图/亮度恢复一致。
  - 快速摇镜排除：相位相关估计全局运动，运动幅度大且累计直方图漂移
    < 0.8 时判为摇镜。
  - 输出 `shots.json`（镜头起止帧、转场类型、置信度）、`keyframes/` 代表帧、
    `timeline.html` 时间线标记。
- `review.py` — 人工修正：`list / delete / merge / split / retype / save`。
  `save` 后自动重提代表帧并重绘时间线，镜头数量变化即同步。
- `sync_outputs.py` — 代表帧提取与时间线渲染的共享模块。

## 用法

```bash
python3 make_test_video.py                                  # 生成测试片段
python3 shot_detector.py test_transitions.mp4 --dump-features features.csv
python3 review.py shots.json                                # 人工修正
```

在 review 中例如：`split 3 400`（在 400 帧处拆分镜头 3）、`delete 1`
（删除误检镜头）、`merge 2`（与下一镜头合并）、`save`（保存并同步
代表帧与时间线）。

## 依赖

`pip install opencv-python-headless numpy`（OpenCV 自带视频编解码，无需 ffmpeg）。
