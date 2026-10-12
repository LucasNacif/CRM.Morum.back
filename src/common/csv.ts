type Cell = string | number | boolean | Date | null | undefined | { toString(): string };

function escape(value: Cell): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * CSV con separador `;` y BOM, que es lo que Excel en español abre bien con doble clic.
 */
export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escape).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
