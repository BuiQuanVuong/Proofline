export function add(a, b) {
  return a + b;
}

export function clamp(x, lo, hi) {
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

export function isAdult(age) {
  return age >= 18;
}
