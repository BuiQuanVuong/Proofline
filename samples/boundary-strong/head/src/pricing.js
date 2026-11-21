export function shipping(weightKg) {
  return weightKg * 2;
}

export function discount(total) {
  if (total >= 100) {
    return total * 0.9;
  }
  return total;
}
