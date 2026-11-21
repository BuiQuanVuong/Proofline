export function atMost(x, max) {
  return Math.min(x, max);
}

export function atLeast(x, min) {
  if (x < min) {
    return min;
  }
  return x;
}
