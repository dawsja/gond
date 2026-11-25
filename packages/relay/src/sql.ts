export type SqlValue = string | number | null;

export interface Sql {
  all(query: string, ...params: SqlValue[]): Record<string, SqlValue>[];
  run(query: string, ...params: SqlValue[]): void;
}
