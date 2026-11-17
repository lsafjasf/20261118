"""Interactive review & manual correction of detected shots.

Commands:
    list                          show all shots
    delete ID                     remove shot ID (merge its range into neighbors)
    merge ID                      merge shot ID with the next shot
    split ID FRAME                split shot ID at FRAME (new boundary)
    retype ID TYPE                set incoming transition: hard_cut|gradual|start
    save                          write shots.json, resync keyframes + timeline
    quit                          exit (prompts if there are unsaved changes)

Usage:
    python3 review.py shots.json [--video V] [--keyframes DIR] [--timeline H]
"""
import argparse
import shlex

import sync_outputs

VALID_TYPES = ("hard_cut", "gradual", "start")


def _renumber(shots):
    for k, s in enumerate(shots):
        s["id"] = k


def _list(shots, fps):
    for s in shots:
        t0, t1 = s["start"] / fps, s["end"] / fps
        print(f"  #{s['id']:2d} frames {s['start']:>4}-{s['end']:>4} "
              f"({t0:6.2f}s-{t1:6.2f}s) in={s['transition_in']:8s} "
              f"conf={s['confidence']:.2f}")


def delete_shot(data, shot_id):
    shots = data["shots"]
    s = shots[shot_id]
    if len(shots) == 1:
        print("cannot delete the only shot")
        return
    if shot_id == 0:
        shots[1]["start"] = s["start"]
        shots[1]["transition_in"] = "start"
        shots[1]["confidence"] = 1.0
    else:
        shots[shot_id - 1]["end"] = s["end"]
    del shots[shot_id]
    _renumber(shots)


def merge_next(data, shot_id):
    shots = data["shots"]
    if shot_id + 1 >= len(shots):
        print("no next shot to merge with")
        return
    shots[shot_id]["end"] = shots[shot_id + 1]["end"]
    del shots[shot_id + 1]
    _renumber(shots)


def split_shot(data, shot_id, frame):
    shots = data["shots"]
    s = shots[shot_id]
    if not (s["start"] < frame <= s["end"]):
        print(f"frame must be in ({s['start']}, {s['end']}]")
        return
    new = {"id": shot_id + 1, "start": frame, "end": s["end"],
           "transition_in": "hard_cut", "confidence": 1.0}
    s["end"] = frame - 1
    shots.insert(shot_id + 1, new)
    _renumber(shots)


def retype(data, shot_id, ttype):
    if ttype not in VALID_TYPES:
        print(f"type must be one of {VALID_TYPES}")
        return
    data["shots"][shot_id]["transition_in"] = ttype


def main():
    ap = argparse.ArgumentParser(description="Manual shot-list correction")
    ap.add_argument("shots", help="shots.json produced by shot_detector.py")
    ap.add_argument("--video", help="defaults to the video stored in shots.json")
    ap.add_argument("--keyframes", default="keyframes")
    ap.add_argument("--timeline", default="timeline.html")
    args = ap.parse_args()

    data = sync_outputs.load_shots(args.shots)
    video = args.video or data["video"]
    fps = data["fps"]
    dirty = False
    print(f"{len(data['shots'])} shots loaded from {args.shots}")
    _list(data["shots"], fps)

    ops = {"delete": delete_shot, "merge": merge_next}
    while True:
        try:
            line = input("review> ").strip()
        except (EOFError, KeyboardInterrupt):
            line = "quit"
        if not line:
            continue
        cmd, *rest = shlex.split(line)
        try:
            if cmd == "list":
                _list(data["shots"], fps)
            elif cmd in ("delete", "merge") and len(rest) == 1:
                ops[cmd](data, int(rest[0]))
                dirty = True
                _list(data["shots"], fps)
            elif cmd == "split" and len(rest) == 2:
                split_shot(data, int(rest[0]), int(rest[1]))
                dirty = True
                _list(data["shots"], fps)
            elif cmd == "retype" and len(rest) == 2:
                retype(data, int(rest[0]), rest[1])
                dirty = True
                _list(data["shots"], fps)
            elif cmd == "save":
                sync_outputs.save_shots(args.shots, data)
                n = sync_outputs.sync(video, args.shots,
                                      args.keyframes, args.timeline)
                print(f"saved {n} shots; keyframes/ and "
                      f"{args.timeline} regenerated")
                dirty = False
            elif cmd == "quit":
                if dirty and input("unsaved changes, quit anyway? [y/N] "
                                   ).strip().lower() != "y":
                    continue
                break
            else:
                print(__doc__)
        except (ValueError, IndexError) as exc:
            print(f"error: {exc}")


if __name__ == "__main__":
    main()
