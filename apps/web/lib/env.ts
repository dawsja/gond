export function env(name: string): string | undefined {
  return process.env[`GOND_${name}`];
}
