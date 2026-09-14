export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
