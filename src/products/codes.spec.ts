import { buildSku, uniqueSku } from './codes.js';

describe('buildSku', () => {
  it('abrevia producto, color y talle', () => {
    expect(buildSku('Remera Oversize', 'Negro', 'M')).toBe('REMO-NEG-M');
  });

  it('quita acentos y símbolos', () => {
    expect(buildSku('Pantalón Cargo', 'Marrón claro', 'XL')).toBe('PANC-MAR-XL');
    expect(buildSku('Jean (mom)', 'Azul', '38')).toBe('JEAM-AZU-38');
  });

  it('usa valores por defecto cuando falta color o talle', () => {
    expect(buildSku('Gorra', ' ', '')).toBe('GOR-UNI-U');
  });
});

describe('uniqueSku', () => {
  it('devuelve el base si está libre', () => {
    expect(uniqueSku('REMO-NEG-M', new Set())).toBe('REMO-NEG-M');
  });

  it('agrega sufijo cuando ya existe', () => {
    expect(uniqueSku('REMO-NEG-M', new Set(['REMO-NEG-M', 'REMO-NEG-M-2']))).toBe('REMO-NEG-M-3');
  });
});
