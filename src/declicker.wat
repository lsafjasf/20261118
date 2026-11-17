;; WebAssembly audio declicker.
;;
;; Input/output PCM is 32-bit float (mono, e.g. 48 kHz). The module owns one
;; linear memory; callers pass byte offsets (pointers) and sample counts.
;;
;; Detection: a click is a *short* run of samples whose first difference is
;; far larger than the local average step magnitude. Real drum attacks are
;; rejected because they keep producing large samples after the impulse
;; (sustained post energy), while clicks collapse back to the local baseline.
;;
;; Repair: either linear interpolation across the region or a mirrored copy
;; of the neighbouring clean segment, both blended from clean anchors so the
;; splice points are continuous.
(module
  (memory (export "memory") 16)

  ;; Tunable thresholds (fixed-point-ish constants live in functions below).
  (global $version i32 (i32.const 1))

  ;; ----------------------------------------------------------------------
  ;; Utility: absolute value of an f64.
  (func $fabs (param $x f64) (result f64)
    (f64.abs (local.get $x)))

  ;; Integer min/max (Wasm only provides f64.min/max natively).
  (func $imin (param $a i32) (param $b i32) (result i32)
    (select (local.get $b) (local.get $a)
      (i32.lt_u (local.get $a) (local.get $b))))

  (func $imax (param $a i32) (param $b i32) (result i32)
    (select (local.get $a) (local.get $b)
      (i32.gt_u (local.get $a) (local.get $b))))

  ;; Median of three f64 values, implemented with comparisons only.
  (func $median3 (param $a f64) (param $b f64) (param $c f64) (result f64)
    (if (result f64) (f64.gt (local.get $a) (local.get $b))
      (then ;; a > b
        (if (result f64) (f64.gt (local.get $b) (local.get $c))
          (then (local.get $b))
          (else
            (if (result f64) (f64.gt (local.get $a) (local.get $c))
              (then (local.get $c))
              (else (local.get $a))))))
      (else ;; b >= a
        (if (result f64) (f64.gt (local.get $a) (local.get $c))
          (then (local.get $a))
          (else
            (if (result f64) (f64.gt (local.get $b) (local.get $c))
              (then (local.get $c))
              (else (local.get $b))))))))

  ;; Read one f32 sample from a byte pointer + sample index, widened to f64.
  (func $load_sample (param $base i32) (param $idx i32) (result f64)
    (f64.promote_f32
      (f32.load
        (i32.add (local.get $base) (i32.shl (local.get $idx) (i32.const 2))))))

  ;; Store one f64 value as f32 at byte pointer + sample index.
  (func $store_sample (param $base i32) (param $idx i32) (param $v f64)
    (f32.store
      (i32.add (local.get $base) (i32.shl (local.get $idx) (i32.const 2)))
      (f32.demote_f64 (local.get $v))))

  ;; Mean magnitude of the first difference over [lo, hi) (hi-1 differences).
  ;; Returns 0 when fewer than two samples are available.
  (func $mean_abs_diff (param $base i32) (param $lo i32) (param $hi i32)
      (result f64)
    (local $sum f64) (local $i i32) (local $d f64)
    (local.set $sum (f64.const 0))
    (if (i32.gt_u (i32.sub (local.get $hi) (local.get $lo)) (i32.const 1))
      (then
        (local.set $i (i32.add (local.get $lo) (i32.const 1)))
        (block $done
          (loop $scan
            (br_if $done (i32.ge_u (local.get $i) (local.get $hi)))
            (local.set $d
              (f64.sub
                (call $load_sample (local.get $base) (local.get $i))
                (call $load_sample (local.get $base)
                  (i32.sub (local.get $i) (i32.const 1)))))
            (local.set $sum (f64.add (local.get $sum) (call $fabs (local.get $d))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $scan)))
        (local.set $sum
          (f64.div (local.get $sum)
            (f64.convert_i32_u
              (i32.sub (local.get $hi) (i32.add (local.get $lo) (i32.const 1))))))))
    (local.get $sum))

  ;; Mean absolute sample value over [lo, hi).
  (func $mean_abs (param $base i32) (param $lo i32) (param $hi i32) (result f64)
    (local $sum f64) (local $i i32)
    (local.set $sum (f64.const 0))
    (if (i32.gt_u (local.get $hi) (local.get $lo))
      (then
        (local.set $i (local.get $lo))
        (block $done
          (loop $scan
            (br_if $done (i32.ge_u (local.get $i) (local.get $hi)))
            (local.set $sum
              (f64.add (local.get $sum)
                (call $fabs (call $load_sample (local.get $base) (local.get $i)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $scan)))
        (local.set $sum
          (f64.div (local.get $sum)
            (f64.convert_i32_u (i32.sub (local.get $hi) (local.get $lo)))))))
    (local.get $sum))

  ;; Maximum absolute sample value over [lo, hi).
  (func $max_abs (param $base i32) (param $lo i32) (param $hi i32) (result f64)
    (local $m f64) (local $i i32) (local $v f64)
    (local.set $m (f64.const 0))
    (local.set $i (local.get $lo))
    (block $done
      (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (local.get $hi)))
        (local.set $v (call $fabs (call $load_sample (local.get $base) (local.get $i))))
        (if (f64.gt (local.get $v) (local.get $m))
          (then (local.set $m (local.get $v))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
    (local.get $m))

  ;; Robust local step-size reference: median of three |steps| taken from a
  ;; wide neighbourhood so an impulse's own edges cannot bias the baseline.
  (func $step_ref (param $base i32) (param $i i32) (result f64)
    (call $median3
      (call $fabs
        (f64.sub (call $load_sample (local.get $base) (i32.sub (local.get $i) (i32.const 4)))
                 (call $load_sample (local.get $base) (i32.sub (local.get $i) (i32.const 5)))))
      (call $fabs
        (f64.sub (call $load_sample (local.get $base) (i32.sub (local.get $i) (i32.const 3)))
                 (call $load_sample (local.get $base) (i32.sub (local.get $i) (i32.const 4)))))
      (call $fabs
        (f64.sub (call $load_sample (local.get $base) (i32.add (local.get $i) (i32.const 2)))
                 (call $load_sample (local.get $base) (i32.add (local.get $i) (i32.const 1)))))))

  ;; ----------------------------------------------------------------------
  ;; Repair mode 0: linear interpolation between the clean anchors just
  ;; outside [lo, hi), i.e. samples lo-1 and hi.
  (func $repair_linear (param $base i32) (param $lo i32) (param $hi i32)
      (param $n i32)
    (local $a f64) (local $b f64) (local $span f64) (local $i i32) (local $t f64)
    ;; Anchor positions fall back to the nearest in-range sample at edges.
    (local $ai i32) (local $bi i32)
    (local.set $ai
      (if (result i32) (i32.gt_u (local.get $lo) (i32.const 0))
        (then (i32.sub (local.get $lo) (i32.const 1)))
        (else (i32.const 0))))
    (local.set $bi
      (if (result i32) (i32.lt_u (local.get $hi) (local.get $n))
        (then (local.get $hi))
        (else (i32.sub (local.get $n) (i32.const 1)))))
    (local.set $a (call $load_sample (local.get $base) (local.get $ai)))
    (local.set $b (call $load_sample (local.get $base) (local.get $bi)))
    (local.set $span (f64.convert_i32_u (i32.sub (local.get $bi) (local.get $ai))))
    (local.set $i (local.get $lo))
    (block $done
      (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (local.get $hi)))
        (if (f64.gt (local.get $span) (f64.const 0))
          (then
            (local.set $t
              (f64.div
                (f64.convert_i32_u (i32.sub (local.get $i) (local.get $ai)))
                (local.get $span)))
            (call $store_sample (local.get $base) (local.get $i)
              (f64.add (local.get $a)
                (f64.mul (local.get $t) (f64.sub (local.get $b) (local.get $a))))))
          (else (call $store_sample (local.get $base) (local.get $i) (local.get $a))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan))))

  ;; Repair mode 1: replace [lo, hi) with the mirrored clean segment on its
  ;; right (preferred) or left. Mirrored values fully overwrite the corrupted
  ;; region (blending with click samples would re-inject the anomaly); short
  ;; fades against the clean anchor samples at lo-1 and hi keep both splice
  ;; points sample-continuous.
  (func $repair_mirror (param $base i32) (param $lo i32) (param $hi i32)
      (param $n i32)
    (local $len i32) (local $i i32) (local $src i32) (local $v f64)
    (local $fade i32) (local $w f64) (local $edge i32) (local $idx i32)
    (local $anchorL f64) (local $anchorR f64)
    (local.set $len (i32.sub (local.get $hi) (local.get $lo)))
    (local.set $anchorL
      (call $load_sample (local.get $base)
        (if (result i32) (i32.gt_u (local.get $lo) (i32.const 0))
          (then (i32.sub (local.get $lo) (i32.const 1)))
          (else (i32.const 0)))))
    (local.set $anchorR
      (call $load_sample (local.get $base)
        (if (result i32) (i32.lt_u (local.get $hi) (local.get $n))
          (then (local.get $hi))
          (else (i32.sub (local.get $n) (i32.const 1))))))
    ;; Fade length: quarter of the region, at least 1, capped at 4 samples.
    (local.set $fade (i32.shr_u (local.get $len) (i32.const 2)))
    (if (i32.eqz (local.get $fade)) (then (local.set $fade (i32.const 1))))
    (if (i32.gt_u (local.get $fade) (i32.const 4))
      (then (local.set $fade (i32.const 4))))
    (local.set $i (i32.const 0))
    (block $done
      (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        ;; Prefer the right-side mirror: src = hi + (len-1-i).
        (local.set $src
          (i32.add (local.get $hi)
            (i32.sub (i32.sub (local.get $len) (i32.const 1)) (local.get $i))))
        (if (i32.ge_u (local.get $src) (local.get $n))
          (then ;; Fall back to left-side mirror: src = lo - (i+1).
            (local.set $src (i32.sub (local.get $lo) (i32.add (local.get $i) (i32.const 1))))))
        (if (i32.ge_u (local.get $src) (local.get $n))
          (then (local.set $src (i32.sub (local.get $n) (i32.const 1)))))
        (local.set $v (call $load_sample (local.get $base) (local.get $src)))
        (local.set $idx (i32.add (local.get $lo) (local.get $i)))
        ;; Entrance fade: clean left anchor -> mirrored value.
        (if (i32.lt_u (local.get $i) (local.get $fade))
          (then
            (local.set $w
              (f64.div (f64.convert_i32_u (i32.add (local.get $i) (i32.const 1)))
                (f64.convert_i32_u (i32.add (local.get $fade) (i32.const 1)))))
            (local.set $v
              (f64.add (f64.mul (local.get $w) (local.get $v))
                (f64.mul (f64.sub (f64.const 1) (local.get $w)) (local.get $anchorL))))))
        (local.set $edge
          (i32.sub (i32.sub (local.get $len) (local.get $i)) (i32.const 1)))
        ;; Exit fade: mirrored value -> clean right anchor.
        (if (i32.lt_u (local.get $edge) (local.get $fade))
          (then
            (local.set $w
              (f64.div (f64.convert_i32_u (i32.add (local.get $edge) (i32.const 1)))
                (f64.convert_i32_u (i32.add (local.get $fade) (i32.const 1)))))
            (local.set $v
              (f64.add (f64.mul (local.get $w) (local.get $v))
                (f64.mul (f64.sub (f64.const 1) (local.get $w)) (local.get $anchorR))))))
        (call $store_sample (local.get $base) (local.get $idx) (local.get $v))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan))))

  ;; ----------------------------------------------------------------------
  ;; Main entry. Scratch layout (all i32 slots, byte offsets):
  ;;   0           : region count k
  ;;   16 ..       : region starts (up to 512)
  ;;   2064 ..     : region ends
  ;;   4120        : per-sample click flags, n int32 (n <= 480000)
  ;;
  ;; (input_ptr, n, scratch_ptr, mode: 0=linear 1=mirror) -> modified samples
  (func $declick (export "declick")
      (param $base i32) (param $n i32) (param $scratch i32) (param $mode i32)
      (result i32)
    (local $i i32) (local $j i32) (local $run i32)
    (local $med f64) (local $thr f64) (local $runthr f64) (local $diff f64) (local $abs f64)
    (local $lo i32) (local $hi i32) (local $post f64) (local $peak f64)
    (local $count i32) (local $total i32)
    ;; Trivial input: too few samples to evaluate a local neighbourhood.
    (if (i32.lt_u (local.get $n) (i32.const 16))
      (then (return (i32.const 0))))
    ;; ---- pass 1: flag candidate click samples ---------------------------
    (local.set $i (i32.const 5))
    (block $scan_done
      (loop $scan
        (br_if $scan_done
          (i32.ge_u (local.get $i) (i32.sub (local.get $n) (i32.const 6))))
        (local.set $med (call $step_ref (local.get $base) (local.get $i)))
        ;; Adaptive threshold: 6x median step, with an absolute floor.
        (local.set $thr
          (f64.max (f64.const 0.02)
            (f64.mul (f64.const 6) (local.get $med))))
        (local.set $diff
          (f64.sub (call $load_sample (local.get $base) (local.get $i))
                   (call $load_sample (local.get $base)
                     (i32.sub (local.get $i) (i32.const 1)))))
        (local.set $abs (call $fabs (local.get $diff)))
        (if (f64.gt (local.get $abs) (local.get $thr))
          (then (i32.store (i32.add (local.get $scratch)
                                   (i32.add (i32.const 4120)
                                     (i32.shl (local.get $i) (i32.const 2))))
                           (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
    ;; ---- pass 2: group flags into runs, reject drum transients ----------
    (local.set $i (i32.const 5))
    (local.set $count (i32.const 0))
    (block $group_done
      (loop $group
        (br_if $group_done
          (i32.ge_u (local.get $i) (i32.sub (local.get $n) (i32.const 6))))
        (local.set $run
          (i32.load (i32.add (local.get $scratch)
                     (i32.add (i32.const 4120)
                       (i32.shl (local.get $i) (i32.const 2))))))
        (if (i32.eqz (local.get $run))
          (then
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $group)))
        ;; Found a flagged run: extend hi while flags continue.
        (local.set $lo (local.get $i))
        (local.set $hi (i32.add (local.get $i) (i32.const 1)))
        ;; Lock a clean baseline at the run's leading edge so the growing
        ;; anomaly cannot bias the extension threshold.
        (local.set $med (call $step_ref (local.get $base) (local.get $lo)))
        (local.set $runthr
          (f64.max (f64.const 0.02) (f64.mul (f64.const 10) (local.get $med))))
        (block $run_done
          (loop $extend
            ;; Stop at the scan boundary or the 16-sample run cap.
            (br_if $run_done
              (i32.or (i32.ge_u (local.get $hi)
                                (i32.sub (local.get $n) (i32.const 6)))
                      (i32.ge_u (i32.sub (local.get $hi) (local.get $lo))
                                (i32.const 16))))
            ;; Extend while flagged, or while the local step still exceeds the
            ;; locked clean baseline (catches multi-sample buzz tails).
            (local.set $diff
              (f64.sub (call $load_sample (local.get $base) (local.get $hi))
                       (call $load_sample (local.get $base)
                         (i32.sub (local.get $hi) (i32.const 1)))))
            (br_if $run_done
              (i32.and
                (i32.eqz
                  (i32.load (i32.add (local.get $scratch)
                             (i32.add (i32.const 4120)
                               (i32.shl (local.get $hi) (i32.const 2))))))
                (f64.le (call $fabs (local.get $diff)) (local.get $runthr))))
            (local.set $hi (i32.add (local.get $hi) (i32.const 1)))
            (br $extend)))
        ;; Region length gate: clicks are short (<= 16 samples).
        (if (i32.le_u (i32.sub (local.get $hi) (local.get $lo)) (i32.const 16))
          (then
            ;; Expand to clean anchors: include one extra sample each side.
            (local.set $j (local.get $lo))
            (if (i32.gt_u (local.get $j) (i32.const 1))
              (then (local.set $lo (i32.sub (local.get $j) (i32.const 1)))))
            (local.set $j (local.get $hi))
            (if (i32.lt_u (local.get $j) (i32.sub (local.get $n) (i32.const 1)))
              (then (local.set $hi (i32.add (local.get $j) (i32.const 1)))))
            ;; Drum guard: sustained post-onset energy means a real transient.
            ;; Compare mean |x| in the 32 samples after the region against
            ;; the local 32-sample pre-region baseline.
            (local.set $post
              (call $mean_abs (local.get $base) (local.get $hi)
                (call $imin (local.get $n) (i32.add (local.get $hi) (i32.const 32)))))
            (local.set $peak
              (call $max_abs (local.get $base) (local.get $lo) (local.get $hi)))
            (local.set $j
              (call $imax (i32.const 0) (i32.sub (local.get $lo) (i32.const 32))))
            (local.set $med
              (call $mean_abs (local.get $base) (local.get $j) (local.get $lo)))
            ;; Accept only when the post-onset energy collapses back to the
            ;; local baseline. A real drum keeps resonating (post stays high)
            ;; and is rejected even against a silent background; a click is
            ;; an isolated spike whose 32-sample tail returns to baseline.
            (if
              (i32.and
                (f64.lt (local.get $post)
                  (f64.mul (f64.const 2.2)
                    (f64.max (local.get $med) (f64.const 0.001))))
                (f64.gt (local.get $peak) (f64.const 0.05)))
              (then
                (if (i32.lt_u (local.get $count) (i32.const 512))
                  (then
                    (i32.store
                      (i32.add (local.get $scratch)
                        (i32.add (i32.const 16)
                          (i32.shl (local.get $count) (i32.const 2))))
                      (local.get $lo))
                    (i32.store
                      (i32.add (local.get $scratch)
                        (i32.add (i32.const 2064)
                          (i32.shl (local.get $count) (i32.const 2))))
                      (local.get $hi))
                    (local.set $count (i32.add (local.get $count) (i32.const 1)))))))
            ;; Skip past the whole run regardless of the verdict.
            (local.set $i (local.get $hi)))
          (else
            (local.set $i (i32.add (local.get $hi) (i32.const 1)))))
        (br $group)))
    (i32.store (local.get $scratch) (local.get $count))
    ;; ---- pass 3: repair accepted regions --------------------------------
    (local.set $total (i32.const 0))
    (local.set $j (i32.const 0))
    (block $fix_done
      (loop $fix
        (br_if $fix_done (i32.ge_u (local.get $j) (local.get $count)))
        (local.set $lo
          (i32.load (i32.add (local.get $scratch)
                     (i32.add (i32.const 16) (i32.shl (local.get $j) (i32.const 2))))))
        (local.set $hi
          (i32.load (i32.add (local.get $scratch)
                     (i32.add (i32.const 2064) (i32.shl (local.get $j) (i32.const 2))))))
        (if (i32.eqz (local.get $mode))
          (then (call $repair_linear (local.get $base) (local.get $lo)
                  (local.get $hi) (local.get $n)))
          (else (call $repair_mirror (local.get $base) (local.get $lo)
                  (local.get $hi) (local.get $n))))
        (local.set $total
          (i32.add (local.get $total) (i32.sub (local.get $hi) (local.get $lo))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $fix)))
    (local.get $total))

  ;; Region count written at scratch[0] after declick() returns.
  (func $region_count (export "region_count") (param $scratch i32) (result i32)
    (i32.load (local.get $scratch)))

  ;; Accessors for the k-th accepted region (start / exclusive end).
  (func $region_start (export "region_start")
      (param $scratch i32) (param $k i32) (result i32)
    (i32.load (i32.add (local.get $scratch)
               (i32.add (i32.const 16) (i32.shl (local.get $k) (i32.const 2))))))

  (func $region_end (export "region_end")
      (param $scratch i32) (param $k i32) (result i32)
    (i32.load (i32.add (local.get $scratch)
               (i32.add (i32.const 2064) (i32.shl (local.get $k) (i32.const 2))))))

  (func $module_version (export "module_version") (result i32)
    (global.get $version))
)
