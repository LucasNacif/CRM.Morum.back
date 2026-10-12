function clean(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .trim();
}

/**
 * SKU legible a partir del producto, color y talle.
 * "Remera Oversize", "Negro", "M" -> "REMO-NEG-M"
 */
export function buildSku(productName: string, color: string, size: string): string {
  const [first = 'PRD', ...rest] = clean(productName).split(/\s+/).filter(Boolean);
  const name = first.slice(0, 3) + rest.slice(0, 3).map((word) => word[0]).join('');
  const colorPart = clean(color).replace(/\s+/g, '').slice(0, 3) || 'UNI';
  const sizePart = clean(size).replace(/\s+/g, '') || 'U';
  return `${name}-${colorPart}-${sizePart}`;
}

/** Agrega sufijo numérico hasta encontrar un SKU libre. */
export function uniqueSku(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}
