import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * Grades an open-ended answer 1 to 5 against a case's rubric. The judge is pinned (model and effort)
 * so scores compare across runs, sees only the conversation, the rubric and the answer, and never
 * which build wrote it. A refusal or a failed call is no grade, never a guess.
 */

const Grade = z.object({
  score: z.number().int().min(1).max(5),
  reason: z.string(),
});

export type JudgeResult = { score: number; reason: string } | { score: null; reason: string };

const INSTRUCTIONS = `You grade one answer from an AI assistant against a rubric. Read the conversation, the rubric and the answer, then give a score from 1 to 5:
5: meets every point of the rubric, correct and well put.
4: correct and complete, with a small lapse in a minor point (tone, length, formatting).
3: mostly right but misses one rubric point or has a minor inaccuracy.
2: misses several points or has a real error.
1: wrong, off task, or no real answer.
Judge only what the rubric asks; don't reward length. Give a one-sentence reason.`;

const prompt = (input: { conversation: string; rubric: string; answer: string }) => `<conversation>\n${input.conversation}\n</conversation>\n\n<rubric>\n${input.rubric}\n</rubric>\n\n<answer>\n${input.answer}\n</answer>`;

/** The judge on an OpenAI-compatible endpoint (BENCH_JUDGE_URL), when no Anthropic key is at hand. */
function openAiJudge(url: string, apiKey: string | undefined, model: string) {
  return async function judge(input: { conversation: string; rubric: string; answer: string }): Promise<JudgeResult> {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey ?? ""}` },
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `${INSTRUCTIONS}\nAnswer only with JSON: {"score": <1-5>, "reason": "<one sentence>"}.` },
            { role: "user", content: prompt(input) },
          ],
        }),
      });
      if (!res.ok) return { score: null, reason: `Judge call failed (${res.status}): ${(await res.text()).slice(0, 200)}` };
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const grade = Grade.safeParse(JSON.parse(data.choices?.[0]?.message?.content ?? "null"));
      return grade.success ? grade.data : { score: null, reason: "The judge's answer didn't parse" };
    } catch (error) {
      return { score: null, reason: `Judge call failed: ${error instanceof Error ? error.message : error}` };
    }
  };
}

export function createJudge(options: { apiKey?: string; model: string; openAiUrl?: string }) {
  if (options.openAiUrl) return openAiJudge(options.openAiUrl, options.apiKey, options.model);
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  return async function judge(input: { conversation: string; rubric: string; answer: string }): Promise<JudgeResult> {
    try {
      const response = await client.messages.parse({
        model: options.model,
        max_tokens: 4000,
        output_config: { effort: "high", format: zodOutputFormat(Grade) },
        system: INSTRUCTIONS,
        messages: [{ role: "user", content: prompt(input) }],
      });
      if (response.stop_reason === "refusal") return { score: null, reason: "The judge declined to grade" };
      const grade = response.parsed_output;
      return grade ? { score: grade.score, reason: grade.reason } : { score: null, reason: "The judge's answer didn't parse" };
    } catch (error) {
      if (error instanceof Anthropic.APIError) return { score: null, reason: `Judge call failed (${error.status ?? "network"}): ${error.message}` };
      throw error;
    }
  };
}

export type Judge = ReturnType<typeof createJudge>;
