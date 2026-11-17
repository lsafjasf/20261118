/* Reference C implementation of the WebAssembly declicker algorithm.
 * Kept structurally identical to src/declicker.wat so the hand-written WAT
 * can be audited against a readable source. Build:
 *   cc -O2 -o build/reference src/reference.c -lm
 */
#include <math.h>
#include <stdint.h>
#include <stdlib.h>

#define MAX_REGIONS 512
#define RUN_CAP 16

static double fabs_(double x) { return fabs(x); }

static double median3(double a, double b, double c) {
  if (a > b) {
    if (b > c) return b;
    return a > c ? c : a;
  }
  if (a > c) return a;
  return b > c ? c : b;
}

static double load(const float *p, int i) { return (double)p[i]; }

static double mean_abs(const float *p, int lo, int hi) {
  if (hi <= lo) return 0.0;
  double s = 0.0;
  for (int i = lo; i < hi; i++) s += fabs_(load(p, i));
  return s / (hi - lo);
}

static double max_abs(const float *p, int lo, int hi) {
  double m = 0.0;
  for (int i = lo; i < hi; i++) {
    double v = fabs_(load(p, i));
    if (v > m) m = v;
  }
  return m;
}

static double step_ref(const float *p, int i) {
  return median3(fabs_(load(p, i - 4) - load(p, i - 5)),
                 fabs_(load(p, i - 3) - load(p, i - 4)),
                 fabs_(load(p, i + 2) - load(p, i + 1)));
}

static void repair_linear(float *p, int lo, int hi, int n) {
  int ai = lo > 0 ? lo - 1 : 0;
  int bi = hi < n ? hi : n - 1;
  double a = load(p, ai), b = load(p, bi);
  double span = (double)(bi - ai);
  for (int i = lo; i < hi; i++) {
    double t = span > 0 ? (i - ai) / span : 0.0;
    p[i] = (float)(a + t * (b - a));
  }
}

static void repair_mirror(float *p, int lo, int hi, int n) {
  int len = hi - lo;
  double anchorL = load(p, lo > 0 ? lo - 1 : 0);
  double anchorR = load(p, hi < n ? hi : n - 1);
  int fade = len / 4;
  if (fade < 1) fade = 1;
  if (fade > 4) fade = 4;
  for (int i = 0; i < len; i++) {
    int src = hi + (len - 1 - i);
    if (src >= n) src = lo - (i + 1);
    if (src >= n) src = n - 1;
    double v = load(p, src);
    if (i < fade) {
      double w = (double)(i + 1) / (fade + 1);
      v = w * v + (1 - w) * anchorL;
    }
    int edge = len - i - 1;
    if (edge < fade) {
      double w = (double)(edge + 1) / (fade + 1);
      v = w * v + (1 - w) * anchorR;
    }
    p[lo + i] = (float)v;
  }
}

typedef struct {
  int count;
  int starts[MAX_REGIONS];
  int ends[MAX_REGIONS];
} Regions;

int declick(float *p, int n, int mode, Regions *out) {
  out->count = 0;
  if (n < 16) return 0;
  uint8_t *flag = (uint8_t *)calloc((size_t)n, 1);
  if (!flag) return -1;

  for (int i = 5; i < n - 6; i++) {
    double med = step_ref(p, i);
    double thr = fmax(0.02, 6.0 * med);
    double d = load(p, i) - load(p, i - 1);
    if (fabs_(d) > thr) flag[i] = 1;
  }

  int total = 0;
  for (int i = 5; i < n - 6;) {
    if (!flag[i]) { i++; continue; }
    int lo = i, hi = i + 1;
    double med0 = step_ref(p, lo);
    double runthr = fmax(0.02, 10.0 * med0);
    while (hi < n - 6 && hi - lo < RUN_CAP) {
      double d = load(p, hi) - load(p, hi - 1);
      if (!flag[hi] && fabs_(d) <= runthr) break;
      hi++;
    }
    if (hi - lo <= RUN_CAP) {
      if (lo > 1) lo--;
      if (hi < n - 1) hi++;
      int pl = lo - 32 > 0 ? lo - 32 : 0;
      double pre = mean_abs(p, pl, lo);
      double post = mean_abs(p, hi, hi + 32 < n ? hi + 32 : n);
      double peak = max_abs(p, lo, hi);
      double base = fmax(pre, 0.001);
      int accept = post < 2.2 * base && peak > 0.05;
      if (accept && out->count < MAX_REGIONS) {
        out->starts[out->count] = lo;
        out->ends[out->count] = hi;
        out->count++;
        if (mode == 0) repair_linear(p, lo, hi, n);
        else repair_mirror(p, lo, hi, n);
        total += hi - lo;
      }
      i = hi;
    } else {
      i = hi + 1;
    }
  }
  free(flag);
  return total;
}
