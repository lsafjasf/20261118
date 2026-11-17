# WebM Cues 索引重建工具

纯 Python 标准库实现（无需 ffmpeg / mkvtoolnix），面向 **Cluster 媒体数据完整、
Cues 索引损坏或缺失** 的 WebM 文件。修复过程不会改动任何原始媒体字节。

## 目录结构

- `src/ebml.py` — EBML VINT / 元素头编解码
- `src/webm_ids.py` — Matroska/WebM 元素 ID 常量
- `src/scanner.py` — 识别 Segment、Info、Tracks，遍历 Cluster 时间码与关键帧
- `src/rebuilder.py` — 重建 CuePoint/CueTrackPositions 并写出修复文件
- `src/seeker.py` — 模拟播放器的 Cue 寻址，验证跳转落点与字节偏移
- `src/synth.py` — 合成 VP8+Opus 测试素材并模拟 Cues 损坏
- `webm_rebuild.py` — 命令行入口
- `tests/test_rebuild.py` — 回归测试

## 用法

```bash
# 端到端演示：生成素材 -> 损坏 Cues -> 重建 -> 10 个时间点寻址对比
python3 webm_rebuild.py demo artifacts

# 只扫描并报告结构（轨道、Cluster、时间码、现有 Cues 覆盖范围）
python3 webm_rebuild.py scan  damaged.webm

# 重建索引，输出新文件；源文件只读，永不修改
python3 webm_rebuild.py fix   damaged.webm repaired.webm

# 回归测试
python3 tests/test_rebuild.py
```

## 修复策略

1. 解析 EBML 头与 Segment，记录 `segment_data_start`（CueClusterPosition 的基准）。
2. 读 Tracks 区分视频轨 / 音频轨（`TrackType`、`CodecID`）。
3. 逐个 Cluster 解析 `Timecode` 与 SimpleBlock/Block：
   - 视频帧依据 SimpleBlock 关键帧位（0x80）或 BlockGroup 无 ReferenceBlock 判定；
   - 记录 Cluster 绝对文件偏移与 Segment 相对偏移。
4. 以关键帧为锚点生成 CuePoint，写入 `CueTime`、`CueTrack`、`CueClusterPosition`。
5. 写出方式二选一，均不触碰 Cluster 字节：
   - unknown-size Segment：新 Cues 直接追加在文件末尾，原始字节逐字节保留为前缀；
   - 定长 Segment：仅重写 Segment 大小头并追加 Cues，Cluster/Info/Tracks 负载原样拷贝。

## 验证口径

- **媒体不变性**：对修复前后所有 Cluster 的精确字节区间分别计算 SHA-256，结果一致；
  unknown-size 路径额外校验修复文件以源文件完整内容为逐字节前缀。
- **可寻址范围**：损坏文件无可用 Cues（只能回到开头）；修复后覆盖首个到末个关键帧
  时间点，`seeker` 按“不晚于目标时间的最新 Cue”模拟 demuxer 跳转。
- **10 个时间点**：每个目标都落在对应关键帧 Cluster，落点时间 <= 目标时间，
  误差不超过关键帧间隔（本素材 2 秒），并输出 Cluster 的绝对/相对字节偏移。
- **哈希变化**：文件整体哈希必然变化（追加了新 Cues 元素），但媒体数据哈希不变，
  量化结果写入 `artifacts/report.json`。

## 演示产物

- `artifacts/clip_damaged.webm` — Cues 负载被 0xAA 覆盖的损坏文件
- `artifacts/clip_repaired.webm` — 重建索引后的可用文件
- `artifacts/report.json` — 哈希、寻址范围、10 次跳转的机器可读结果
