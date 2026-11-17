"""Generate a synthetic test clip containing three transition types plus
distractors (camera flash, fast pan) that the detector must reject.

Ground truth (24 fps, 640x360):
  shot 1: frames   0- 71  scene A (moving circle)
  CUT at 72               hard cut
  shot 2: frames  72-167  scene B (moving rectangle), flash at frame 100
  DISSOLVE 168-191        gradual (crossfade, 24 frames)
  shot 3: frames 192-263  scene C (rotating bars)
  FADE 264-311            gradual (fade out 24f through black, fade in 24f)
  shot 4: frames 312-479  scene D (landscape, fast pan frames 380-399)
"""
import cv2
import numpy as np

W, H, FPS = 640, 360, 24
OUT = "test_transitions.mp4"
GT_FILE = "ground_truth.txt"


def scene_a(t):
    img = np.full((H, W, 3), (60, 30, 20), np.uint8)  # dark blue-ish
    x = int(80 + (W - 160) * (t % 144) / 144)
    cv2.circle(img, (x, H // 2), 40, (0, 200, 255), -1)
    cv2.putText(img, "A", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    return img


def scene_b(t):
    img = np.full((H, W, 3), (20, 90, 40), np.uint8)  # green-ish
    y = int(60 + (H - 160) * (t % 192) / 192)
    cv2.rectangle(img, (W // 2 - 60, y), (W // 2 + 60, y + 50), (255, 80, 0), -1)
    cv2.putText(img, "B", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    return img


def scene_c(t):
    img = np.full((H, W, 3), (30, 30, 90), np.uint8)  # red-ish
    for k in range(5):
        x = (t + k * 130) % W
        cv2.rectangle(img, (x, 0), (min(x + 24, W), H), (200, 200, 60), -1)
    cv2.putText(img, "C", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    return img


LANDSCAPE_W = W * 3


def _landscape():
    rng = np.random.default_rng(7)
    img = np.zeros((H, LANDSCAPE_W, 3), np.uint8)
    img[:] = (120, 90, 40)
    for _ in range(60):
        x, y = rng.integers(0, LANDSCAPE_W), rng.integers(0, H)
        r = int(rng.integers(8, 40))
        color = tuple(int(c) for c in rng.integers(40, 255, 3))
        cv2.circle(img, (int(x), int(y)), r, color, -1)
    cv2.putText(img, "D", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    return img


LANDSCAPE = _landscape()


def scene_d(t):
    # fast pan between frames 380-399 (local 68-87): 20 px/frame shift
    local = t - 312
    if 68 <= local < 88:
        off = 200 + (local - 68) * 20
    elif local >= 88:
        off = 200 + 19 * 20
    else:
        off = 200
    return LANDSCAPE[:, off:off + W].copy()


def main():
    writer = cv2.VideoWriter(OUT, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    for f in range(480):
        if f < 72:
            img = scene_a(f)
        elif f < 168:
            img = scene_b(f)
            if f == 100:  # camera flash: single overexposed frame
                img = np.full((H, W, 3), 245, np.uint8)
        elif f < 192:  # dissolve B -> C
            a = (f - 168) / 24.0
            img = cv2.addWeighted(scene_b(f), 1 - a, scene_c(f), a, 0)
        elif f < 264:
            img = scene_c(f)
        elif f < 312:  # fade out then fade in through black
            if f < 288:
                a = (f - 264) / 24.0
                img = (scene_c(f) * (1 - a)).astype(np.uint8)
            else:
                a = (f - 288) / 24.0
                img = (scene_d(312) * a).astype(np.uint8)
        else:
            img = scene_d(f)
        writer.write(img)
    writer.release()

    with open(GT_FILE, "w") as fh:
        fh.write("# ground truth transitions (frame indices)\n")
        fh.write("hard_cut 72\n")
        fh.write("dissolve 168 191\n")
        fh.write("fade 264 311\n")
        fh.write("reject_flash 100\n")
        fh.write("reject_pan 380 399\n")
    print(f"wrote {OUT} (480 frames) and {GT_FILE}")


if __name__ == "__main__":
    main()
