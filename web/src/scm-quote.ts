export const quotePath = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`;
