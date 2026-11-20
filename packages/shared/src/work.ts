export type WorkStep = {
  id: string;
  kind: "command" | "file" | "tool" | "note";

  title: string;

  detail: string | null;

  output: string | null;
  status: "running" | "done" | "failed";

  quiet?: boolean;
  at: string;
};

export const WORK_OUTPUT_MAX = 8_000;

export const WORK_STEPS_MAX = 200;
