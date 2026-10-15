import { roundPrice } from './pricing.js';

describe('roundPrice', () => {
  it('sin redondeo deja dos decimales', () => {
    expect(roundPrice(14317.456, 0)).toBe(14317.46);
  });

  it('redondea hacia arriba al múltiplo', () => {
    expect(roundPrice(14317, 100)).toBe(14400);
    expect(roundPrice(14317, 500)).toBe(14500);
    expect(roundPrice(14317, 1000)).toBe(15000);
  });

  it('un precio que ya es múltiplo no cambia', () => {
    expect(roundPrice(14500, 500)).toBe(14500);
  });

  it('no sube por errores de punto flotante', () => {
    // 10000 * 1.1 da 11000.000000000002 en JavaScript.
    expect(roundPrice(10000 * 1.1, 1000)).toBe(11000);
  });
});
