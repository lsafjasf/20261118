"""Shot boundary detector.

Computes per-frame color histograms (HSV), edge maps (Canny) and mean
brightness, then classifies inter-frame differences into hard cuts and
gradual transitions (dissolve/fade/wipe). Short-lived changes caused by
camera flashes or fast pans are rejected.

Usage:
    python3 shot_detector.py VIDEO [-o shots.json] [--keyframes DIR]
"""
import argparse
import json
import os

import cv2
import numpy as np

PROC_WIDTH = 320          # frames are downscaled to this width for features
HIST_BINS = (16, 8, 8)    # H, S, V bins
W_HIST, W_EDGE = 0.6, 0.4  # weights of the combined difference score
CUT_K = 5.0               # hard-cut threshold = mean + CUT_K * std (min CUT_MIN)
CUT_MIN = 0.35
CUT_HIST_MIN = 0.6        # a hard cut also needs a large 1-frame hist jump
GRAD_K = 3.0              # gradual threshold on hist distance = med + GRAD_K*MAD
GRAD_MIN = 0.08           # floor for the per-frame hist-distance threshold
MIN_GRAD_LEN = 4          # gradual transitions last at least this many frames
GRAD_GAP = 1              # tolerated sub-threshold gap inside a gradual region
FLASH_MAX_LEN = 2         # a flash disturbs at most this many frames
PAN_MOTION_PX = 6.0       # mean global motion (px, downscaled) that marks a pan
PAN_FAR_MAX = 0.8         # pans keep some hist similarity; dissolves do not


def _hist(frame):
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h = cv2.calcHist([hsv], [0, 1, 2], None, HIST_BINS, [0, 180, 0, 256, 0, 256])
    cv2.normalize(h, h, 0, 1, cv2.NORM_MINMAX)
    return h


def _edges(gray):
    e = cv2.Canny(gray, 80, 200)
    return cv2.dilate(e, np.ones((3, 3), np.uint8))


def extract_features(video_path):
    """Return dict of per-frame feature arrays plus fps and frame count."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    hists, edge_maps, brightness, motions = [], [], [], [0.0]
    prev_gray = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        scale = PROC_WIDTH / frame.shape[1]
        small = cv2.resize(frame, (PROC_WIDTH, int(frame.shape[0] * scale)))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        hists.append(_hist(small))
        edge_maps.append(_edges(gray))
        brightness.append(float(gray.mean()))
        if prev_gray is not None:
            (dx, dy), _ = cv2.phaseCorrelate(
                np.float32(prev_gray), np.float32(gray))
            motions.append(float(np.hypot(dx, dy)))
        prev_gray = gray
    cap.release()
    return {
        "fps": fps,
        "n_frames": len(hists),
        "hists": hists,
        "edges": edge_maps,
        "brightness": np.array(brightness),
        "motion": np.array(motions),
    }


def frame_differences(feat):
    """Per-adjacent-frame histogram distance, edge diff and brightness delta.

    Returns arrays of length n_frames-1; index i compares frame i and i+1.
    """
    n = feat["n_frames"]
    hist_d = np.zeros(n - 1)
    edge_d = np.zeros(n - 1)
    for i in range(n - 1):
        hist_d[i] = cv2.compareHist(feat["hists"][i], feat["hists"][i + 1],
                                    cv2.HISTCMP_BHATTACHARYYA)
        a, b = feat["edges"][i], feat["edges"][i + 1]
        denom = max(1.0, 0.5 * (np.count_nonzero(a) + np.count_nonzero(b)))
        edge_d[i] = np.count_nonzero(cv2.bitwise_xor(a, b)) / denom
    bright_d = np.abs(np.diff(feat["brightness"])) / 255.0
    score = W_HIST * hist_d + W_EDGE * np.clip(edge_d, 0, 1)
    return {"hist": hist_d, "edge": edge_d, "bright": bright_d, "score": score}


def _is_flash(diff, feat, i):
    """True if the spike at boundary i (frames i -> i+1) is a short flash.

    A flash disturbs <= FLASH_MAX_LEN frames; frames just before and just
    after the disturbance look alike and brightness returns to baseline.
    """
    n = feat["n_frames"]
    for length in range(1, FLASH_MAX_LEN + 1):
        before, after = i, i + length + 1
        if after >= n:
            continue
        sim = cv2.compareHist(feat["hists"][before], feat["hists"][after],
                              cv2.HISTCMP_BHATTACHARYYA)
        bright_back = abs(feat["brightness"][after]
                          - feat["brightness"][before]) < 40
        if sim < 0.25 and bright_back:
            mid = feat["brightness"][before + 1:after]
            if len(mid) and (mid.max() - mid.min() > 30
                             or abs(mid.max() - feat["brightness"][before]) > 30):
                return True
    return False


def _is_pan(feat, start, end, far=0.0):
    """True if frames [start, end] are dominated by fast global motion.

    A genuine gradual transition between different shots drifts the color
    histogram all the way (far ~ 1); a pan keeps partial similarity, so a
    high-motion region is only a pan when `far` stays below PAN_FAR_MAX.
    """
    if far >= PAN_FAR_MAX:
        return False
    seg = feat["motion"][max(1, start):end + 2]
    return len(seg) > 0 and float(seg.mean()) > PAN_MOTION_PX


def detect_transitions(feat, diff):
    """Return list of transitions: {type, start, end, confidence, ...}.

    `start`/`end` are frame indices of the transition region; for a hard cut
    start == end == first frame of the new shot.
    """
    score = diff["score"]        # combined hist+edge, for hard cuts
    hist_d = diff["hist"]        # hist-only drift, for gradual transitions
    med = float(np.median(score))
    mad = float(np.median(np.abs(score - med))) * 1.4826
    cut_thr = max(CUT_MIN, med + CUT_K * mad)
    hmed = float(np.median(hist_d))
    hmad = float(np.median(np.abs(hist_d - hmed))) * 1.4826
    grad_thr = max(GRAD_MIN, hmed + GRAD_K * hmad)
    n = feat["n_frames"]
    transitions = []
    i = 0
    while i < n - 1:
        if score[i] >= cut_thr and hist_d[i] >= CUT_HIST_MIN:
            # a hard cut is an isolated spike; sustained elevation around it
            # means a gradual transition or camera motion instead
            lo = score[max(0, i - 1)]
            hi = score[min(n - 2, i + 1)]
            isolated = lo < 0.6 * cut_thr and hi < 0.6 * cut_thr
            if not isolated:
                i += 1
                continue
            if _is_flash(diff, feat, i):
                i += FLASH_MAX_LEN + 1
                continue
            if _is_pan(feat, i, i + 1, far=1.0):
                i += 1
                continue
            conf = min(1.0, 0.5 + 0.5 * (score[i] - cut_thr)
                       / max(1e-6, score.max() - cut_thr))
            transitions.append({"type": "hard_cut", "start": i + 1,
                                "end": i + 1, "confidence": round(conf, 3),
                                "score": round(float(score[i]), 3)})
            i += 1
        elif hist_d[i] >= grad_thr and score[i] < cut_thr:
            j = i
            # extend region, tolerating short sub-threshold gaps
            while j + 1 < n - 1:
                nxt = j + 1
                if hist_d[nxt] >= grad_thr:
                    j = nxt
                    continue
                gap_end = nxt + GRAD_GAP
                window = hist_d[nxt:gap_end + 1]
                if len(window) and window.max() >= grad_thr:
                    j = int(np.argmax(window)) + nxt
                    continue
                break
            length = j - i + 1
            # cumulative change across the whole region
            far = cv2.compareHist(feat["hists"][i],
                                  feat["hists"][min(j + 1, n - 1)],
                                  cv2.HISTCMP_BHATTACHARYYA)
            if (length >= MIN_GRAD_LEN and far >= CUT_MIN
                    and not _is_pan(feat, i, j + 1, far=far)):
                conf = min(1.0, 0.4 + 0.4 * far + 0.2 * min(1.0, length / 16))
                transitions.append({"type": "gradual", "start": i + 1,
                                    "end": j + 1,
                                    "confidence": round(conf, 3),
                                    "score": round(float(hist_d[i:j + 1].max()), 3)})
            i = j + 1
        else:
            i += 1
    return transitions


def build_shots(n_frames, transitions):
    """Convert transitions into shots with start/end frames and confidence."""
    bounds = []
    for t in transitions:
        if t["type"] == "hard_cut":
            bounds.append((t["start"], t["start"], t))
        else:
            bounds.append((t["start"], t["end"] + 1, t))
    shots = []
    prev = 0
    for start, next_start, t in bounds:
        if start > prev:
            shots.append({"id": len(shots), "start": prev, "end": start - 1})
        prev = next_start
    if prev < n_frames:
        shots.append({"id": len(shots), "start": prev, "end": n_frames - 1})
    for k, s in enumerate(shots):
        s["id"] = k
        incoming = next((t for _, e, t in bounds if e == s["start"]), None)
        s["transition_in"] = incoming["type"] if incoming else "start"
        s["confidence"] = incoming["confidence"] if incoming else 1.0
    return shots


def main():
    ap = argparse.ArgumentParser(description="Shot boundary detector")
    ap.add_argument("video")
    ap.add_argument("-o", "--output", default="shots.json")
    ap.add_argument("--keyframes", default="keyframes")
    ap.add_argument("--timeline", default="timeline.html")
    ap.add_argument("--no-artifacts", action="store_true",
                    help="skip keyframe/timeline generation")
    ap.add_argument("--dump-features", metavar="CSV",
                    help="write per-frame hist/edge/brightness differences")
    args = ap.parse_args()

    feat = extract_features(args.video)
    diff = frame_differences(feat)
    if args.dump_features:
        with open(args.dump_features, "w") as fh:
            fh.write("boundary,hist_dist,edge_diff,brightness_delta,"
                     "brightness,combined_score\n")
            for i in range(feat["n_frames"] - 1):
                fh.write(f"{i + 1},{diff['hist'][i]:.4f},{diff['edge'][i]:.4f},"
                         f"{diff['bright'][i]:.4f},{feat['brightness'][i + 1]:.2f},"
                         f"{diff['score'][i]:.4f}\n")
        print(f"per-frame features -> {args.dump_features}")
    transitions = detect_transitions(feat, diff)
    shots = build_shots(feat["n_frames"], transitions)
    data = {"video": os.path.abspath(args.video), "fps": feat["fps"],
            "n_frames": feat["n_frames"], "transitions": transitions,
            "shots": shots}
    with open(args.output, "w") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)

    print(f"{feat['n_frames']} frames @ {feat['fps']:.2f} fps")
    for t in transitions:
        print(f"  {t['type']:8s} frames {t['start']:>4}-{t['end']:>4} "
              f"conf={t['confidence']:.2f}")
    print(f"{len(shots)} shots -> {args.output}")

    if not args.no_artifacts:
        import sync_outputs
        sync_outputs.save_shots(args.output, data)
        n = sync_outputs.sync(args.video, args.output,
                              args.keyframes, args.timeline)
        print(f"synced {n} keyframes and {args.timeline}")


if __name__ == "__main__":
    main()
