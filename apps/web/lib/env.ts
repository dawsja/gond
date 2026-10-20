export function env(name: string): string | undefined {
  return process.env[`GOND_${name}`] ?? process.env[`KRU_${name}`];
}
