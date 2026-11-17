# 视频旋转矩阵检测与物理归正工具

`video_orient.py` 读取 MP4/MOV 中的方向信息，区分“容器元数据”和“真实
像素数据”，并在用户确认后把旋转/翻转烘焙进像素，同时清除全部旋转标记，
保证输出不会被播放器二次旋转。

## 背景：两类旋转信息

- **像素数据（decoded pixels）**：H.264/HEVC 码流里实际的采样网格，
  即解码器吐出来的原始宽高，旋转不会改变它。
- **容器元数据（display matrix / rotate tag）**：
  - 现代写法是 tkhd 里的 3x3 Display Matrix（ffprobe 的
    `side_data_list` 中类型为 `Display Matrix`），可表达 0/90/180/270
    度旋转以及水平/垂直翻转，角度按逆时针解释。
  - 旧写法是 QuickTime/MP4 的 `rotate` 自由格式 tag（角度按顺时针
    解释）。ffmpeg 6 起不再依据该 tag 自动旋转，本工具会显式补做。
  - 两者同时存在时属于“重复旋转标记”，工具会告警，归正时只应用一次
    变换并把两种标记一并清除。

## 用法

工具自动使用仓库内 `bin/ffmpeg`、`bin/ffprobe`（静态构建），PATH 中
存在系统 ffmpeg 时也可直接复用。

```bash
# 只检测：展示原始解码宽高、显示宽高、旋转角、翻转和标记来源
python3 video_orient.py inspect input.mp4
python3 video_orient.py inspect input.mp4 --json

# 归正：交互确认后转码，把方向烘焙进像素并清除标记
python3 video_orient.py normalize input.mp4 output.mp4

# 脚本中跳过确认；音频默认 copy（逐字节保留，利于同步验证）
python3 video_orient.py normalize input.mp4 output.mp4 --yes

# 查看将执行的 ffmpeg 命令而不实际转码
python3 video_orient.py normalize input.mp4 output.mp4 --dry-run
```

常用选项：`--crf`（默认 18）、`--preset`（默认 medium）、
`--audio-codec`（默认 `copy`，可设 `aac` 重编码）。

## 归正如何保证只旋转一次

- 存在 Display Matrix 时：使用 ffmpeg 内建 autorotate，矩阵被消费一次
  后烘焙进像素，不会写入输出流。
- 仅存在 legacy `rotate` tag 时：加 `-noautorotate` 并显式插入
  `transpose` 滤镜（顺时针角度已换算），避免新旧逻辑叠加。
- 输出统一加 `-map_metadata -1 -map_chapters -1` 并显式清空
  `rotate=`，从容器层面杜绝残留标记。
- 转码后工具自检：输出不得含任何 Display Matrix/rotate 标记，且像素
  宽高必须等于输入的显示宽高，否则以非零码退出。

## 测试

```bash
./run_tests.sh
```

测试夹具全部现场生成（不随仓库提交大文件），覆盖：

- 横屏源 + 90 度矩阵、竖屏源 + 90 度矩阵、带 hflip/vflip 的矩阵；
- legacy `rotate` tag 以及“矩阵 + tag”双标记样本（由
  `tests/mp4legacy.py` 直接构造 ISO-BMFF box）；
- 全部 8 种唯一方向矩阵，用四角色标逐像素校验播放器可见方向；
- 音频 `copy` 路径解码波形逐字节一致、音频包 PTS 不变、音视频时长对齐；
- 重复处理幂等：归正后的文件再次运行不会发生二次旋转或宽高颠倒。
