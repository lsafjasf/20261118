"""纯标准库 DSP：RMS 包络、起音点检测、互相关对齐精修。"""

from __future__ import annotations

import math


def rms_envelope(samples: list[float], sample_rate: int, hop_ms: float = 5.0,
                 win_ms: float = 10.0) -> tuple[list[float], list[float]]:
    """返回 (包络时间秒序列, RMS 幅度序列)，滑动窗 RMS。"""
    hop = max(1, int(sample_rate * hop_ms / 1000.0))
    half = max(1, int(sample_rate * win_ms / 1000.0) // 2)
    total = len(samples)
    times: list[float] = []
    values: list[float] = []
    start = 0
    while start < total:
        left = max(0, start - half)
        right = min(total, start + half)
        accum = 0.0
        for value in samples[left:right]:
            accum += value * value
        values.append(math.sqrt(accum / max(1, right - left)))
        times.append(start / sample_rate)
        start += hop
    return times, values


def detect_onsets(samples: list[float], sample_rate: int, hop_ms: float = 5.0,
                  refractory_ms: float = 60.0) -> list[dict]:
    """基于包络正变化率的起音检测，返回 [{time, strength}]，按时间排序。"""
    times, values = rms_envelope(samples, sample_rate, hop_ms=hop_ms)
    if not values:
        return []
    ordered = sorted(values)
    noise = ordered[len(ordered) // 5] or 1e-6
    refractory = refractory_ms / hop_ms
    onsets: list[dict] = []
    last_kept = -1e9
    for index in range(1, len(values)):
        delta = values[index] - values[index - 1]
        strength = delta / noise
        if (values[index] > 6.0 * noise and strength > 3.0
                and index - last_kept >= refractory):
            onsets.append({"time": round(times[index], 3), "strength": round(strength, 5)})
            last_kept = index
    return onsets


def pick_slate(samples: list[float], sample_rate: int) -> dict:
    """场记板脉冲 = 全轨最强起音点。"""
    onsets = detect_onsets(samples, sample_rate)
    if not onsets:
        raise ValueError("未检测到任何起音点，无法定位场记板脉冲")
    slate = max(onsets, key=lambda item: item["strength"])
    peak_sec = locate_peak(samples, sample_rate, slate["time"])
    return {"onsets": onsets, "slate": slate, "slatePeakSec": peak_sec}


def locate_peak(samples: list[float], sample_rate: int, around_sec: float,
                window_ms: float = 50.0) -> float:
    """在起音点附近 ±window 内找绝对幅度峰，返回秒（样本级精度）。"""
    center = int(around_sec * sample_rate)
    radius = int(sample_rate * window_ms / 1000.0)
    left = max(0, center - radius)
    right = min(len(samples), center + radius)
    best_index = left
    best_magnitude = -1.0
    for index in range(left, right):
        magnitude = abs(samples[index])
        if magnitude > best_magnitude:
            best_magnitude = magnitude
            best_index = index
    return best_index / sample_rate


def residual_lag_ms(reference: list[float], target: list[float],
                    sample_rate: int, expected_lag: int,
                    search_ms: float = 25.0) -> float:
    """在期望延迟附近，用包络网格求残余延迟（毫秒）。

    期望 lag 为 0 的短窗口验证场景：搜索范围内先粗后细，
    返回 measured_lag - expected_lag 的毫秒残差绝对值由调用方处理。
    """
    measured_lag, _ = envelope_lag(reference, target, sample_rate,
                                   expected_lag, search_ms=search_ms,
                                   hop_ms=2.0, win_ms=10.0, active_frac=0.4)
    return (measured_lag - expected_lag) / sample_rate * 1000.0


def envelope_lag(reference: list[float], target: list[float], sample_rate: int,
                 expected_lag: int, search_ms: float = 40.0,
                 hop_ms: float = 5.0, win_ms: float = 20.0,
                 active_frac: float = 0.3) -> tuple[int, float]:
    """RMS 包络网格两阶段相关。

    lag 约定（即轨道对齐偏移）：target 比主时间线晚开始 lag 个采样，
    tgt[i] 与 ref[i + lag] 对齐。先 hop 网格粗搜，再 1ms 子网格细搜。
    """
    ref_env = _downsample_envelope(reference, sample_rate, hop_ms, win_ms)
    tgt_env = _downsample_envelope(target, sample_rate, hop_ms, win_ms)
    hop = max(1, int(sample_rate * hop_ms / 1000.0))
    expected_grid = int(round(expected_lag / hop))
    radius_grid = int(search_ms / hop_ms) + 1

    best_grid = expected_grid
    best_corr = -2.0
    for grid_lag in range(expected_grid - radius_grid, expected_grid + radius_grid + 1):
        corr = _grid_corr(ref_env, tgt_env, grid_lag, active_frac)
        if corr > best_corr:
            best_corr, best_grid = corr, grid_lag

    return _subgrid_fine(ref_env, tgt_env, hop, best_grid, int(hop_ms), active_frac)


def _downsample_envelope(samples: list[float], sample_rate: int,
                         hop_ms: float, win_ms: float) -> list[float]:
    _, values = rms_envelope(samples, sample_rate, hop_ms, win_ms)
    return values


def _overlap_bounds(length_ref: int, length_tgt: int, grid_lag: float) -> tuple[int, int]:
    """返回满足 j = i + grid_lag 的 ref 下标合法区间 [first_ref, last_ref)。"""
    first_ref = max(0, math.ceil(grid_lag - 1e-9))
    last_ref = min(length_ref, math.floor(grid_lag + length_tgt - 1e-9) + 1)
    return first_ref, last_ref


def _grid_corr(ref_env: list[float], tgt_env: list[float], grid_lag: int,
               active_frac: float) -> float:
    first_ref, last_ref = _overlap_bounds(len(ref_env), len(tgt_env), grid_lag)
    if last_ref - first_ref < 16:
        return -2.0
    window = ref_env[first_ref:last_ref]
    ranked = sorted(window, reverse=True)
    cutoff = ranked[min(len(ranked) - 1, int(len(ranked) * active_frac))]
    return _corr_with_cutoff(ref_env, tgt_env, grid_lag, first_ref, last_ref, cutoff)


def _corr_with_cutoff(ref_env: list[float], tgt_env: list[float], grid_lag: float,
                      first_ref: int, last_ref: int, cutoff: float) -> float:
    sum_a = sum_b = sum_aa = sum_bb = sum_ab = 0.0
    count = 0
    for ref_index in range(first_ref, last_ref):
        if ref_env[ref_index] < cutoff:
            continue
        tgt_index = int(round(ref_index - grid_lag))
        if tgt_index < 0 or tgt_index >= len(tgt_env):
            continue
        a = ref_env[ref_index]
        b = tgt_env[tgt_index]
        sum_a += a
        sum_b += b
        sum_aa += a * a
        sum_bb += b * b
        sum_ab += a * b
        count += 1
    if count < 8:
        return -2.0
    mean_a, mean_b = sum_a / count, sum_b / count
    denom = math.sqrt(max(0.0, sum_aa - count * mean_a * mean_a)
                      * max(0.0, sum_bb - count * mean_b * mean_b))
    if denom <= 0.0:
        return -2.0
    return (sum_ab - count * mean_a * mean_b) / denom


def _subgrid_fine(ref_env: list[float], tgt_env: list[float], hop: int,
                  best_grid: int, sub_steps: int, active_frac: float
                  ) -> tuple[int, float]:
    coarse_lag = best_grid * hop
    step_samples = max(1, hop // max(1, sub_steps))
    # 活动帧阈值按整段 ref 包络固定，保证不同候选 lag 可比
    ranked = sorted(ref_env, reverse=True)
    cutoff = ranked[min(len(ranked) - 1, int(len(ranked) * active_frac))]
    best_lag, best_corr = coarse_lag, -2.0
    for sub in range(-hop, hop + step_samples, step_samples):
        lag = coarse_lag + sub
        grid_lag = lag / hop
        first_ref, last_ref = _overlap_bounds(len(ref_env), len(tgt_env), grid_lag)
        if last_ref - first_ref < 16:
            continue
        corr = _corr_with_cutoff(ref_env, tgt_env, grid_lag,
                                 first_ref, last_ref, cutoff)
        if corr > best_corr:
            best_corr, best_lag = corr, lag
    return best_lag, max(0.0, best_corr)


