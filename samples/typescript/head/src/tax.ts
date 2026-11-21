export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function gst(amount: number, exempt: boolean): number {
  return exempt ? 0 : round2(amount * 0.1);
}
