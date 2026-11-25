#include <stdio.h>
__attribute__((noinline)) int crash_here(int *p) { return *p + 1; }
__attribute__((noinline)) int middle(int x) { int *p = x > 100 ? &x : 0; return crash_here(p); }
int main(int argc, char **argv) { printf("%d\n", middle(argc)); return 0; }
