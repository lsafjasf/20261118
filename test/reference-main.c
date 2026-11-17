/* Driver for src/reference.c: reads raw f32 mono, writes repaired raw f32.
 * Usage: reference <mode 0|1> <in.f32> <out.f32> <n>
 */
#include <stdio.h>
#include <stdlib.h>
#include "../src/reference.c"

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: %s <mode> <in.f32> <out.f32> <n>\n", argv[0]);
    return 2;
  }
  int mode = atoi(argv[1]);
  int n = atoi(argv[4]);
  float *buf = (float *)malloc((size_t)n * sizeof(float));
  FILE *in = fopen(argv[2], "rb");
  if (!in || fread(buf, sizeof(float), (size_t)n, in) != (size_t)n) {
    fprintf(stderr, "read failed\n");
    return 2;
  }
  fclose(in);
  Regions regions;
  int modified = declick(buf, n, mode, &regions);
  if (modified < 0) return 3;
  FILE *out = fopen(argv[3], "wb");
  fwrite(buf, sizeof(float), (size_t)n, out);
  fclose(out);
  printf("regions=%d modified=%d\n", regions.count, modified);
  for (int k = 0; k < regions.count; k++)
    printf("%d %d\n", regions.starts[k], regions.ends[k]);
  free(buf);
  return 0;
}
