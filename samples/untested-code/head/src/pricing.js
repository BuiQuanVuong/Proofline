export function shipping(weightKg) {
  return weightKg * 2;
}

export function parseQuantity(input) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1) {
    return null;
  }
  return n;
}
