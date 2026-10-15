/**
 * Redondea un precio hacia arriba al múltiplo indicado (0 = solo a centavos).
 * Hacia arriba para que un aumento nunca termine bajando el precio.
 */
export function roundPrice(price: number, roundTo: number): number {
  if (roundTo > 0) return Math.ceil(Math.round(price * 100) / 100 / roundTo) * roundTo;
  return Math.round(price * 100) / 100;
}
