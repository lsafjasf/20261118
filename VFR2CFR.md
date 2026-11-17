# VFR → CFR 转换工具

把可变帧率（VFR）素材按“每帧 PTS 时间映射”转换为固定帧率（CFR），
转换过程是逐帧重建（解码 → 按映射重组 → 重新编码），不是重新打时间戳。

## 用法

```bash
# 生成测试素材（不规则帧间隔 16.7–83.3ms，含音频同步蜂鸣）
python3 make_sample.py            # 产出 sample/vfr_source.mp4

# 转换（重复/丢弃策略，默认 nearest）
python3 vfr2cfr.py sample/vfr_source.mp4 -o out_cfr30.mp4 --fps 30 \
    --strategy nearest --workdir out_nearest

# 其他策略：floor（取不晚于槽位的最近帧）/ mi（minterpolate 运动插帧）
python3 vfr2cfr.py sample/vfr_source.mp4 -o out_mi.mp4 --strategy mi
```

## 原理

1. `ffprobe` 提取源文件每一帧的 PTS。
2. 对每个输出槽位 `t = n/fps` 选择源帧，建立映射；输出帧数按容器
   总时长锁定（`n_out = round(duration * fps)`），保证音画零漂移。
3. 源帧解码为 PNG（`-fps_mode passthrough`，防止被中间环节量化），
   输出帧以硬链接指向映射的源帧，image2 按 `-framerate` 精确打
   `n/fps` 时间戳后重新编码；音频流直接 copy。

## 产物

- `<workdir>/<name>_timeline.csv`：每个输出帧 → 源帧的映射，
  `action` 列标出 `NEW`/`DUP`；缺失的源帧号即被 SKIP 的帧。
- `<workdir>/<name>_timeline.svg`：双泳道时间轴，红点=被跳过的源帧，
  橙块=被复制的输出槽位。
- `<workdir>/report.json`：时长/帧数摘要。

## 自动校验（转换后打印）

- 源/输出容器时长、音频流时长及漂移；
- 全时间轴与快速运动窗口（`--fast-window 4-8`）的帧间隔统计
  （min/max/mean/std）；
- 音频蜂鸣同步点（silencedetect 起点）逐个对比。
