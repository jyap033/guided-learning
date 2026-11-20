import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { LlmProvider, LlmTask } from "./provider.ts";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Calls the Claude API directly. Needs ANTHROPIC_API_KEY (or another credential
 * the SDK can find). Uses structured outputs so the reply is parsed against the
 * task's schema, and server-side refusal fallbacks so a rare refusal is retried
 * on a fallback model instead of failing the step.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private client = new Anthropic();

  constructor(private opts: { model?: string; effort?: Effort } = {}) {
    this.name = `anthropic-api:${this.model}`;
  }

  private get model(): string {
    return this.opts.model ?? "claude-opus-5-5";
  }

  async complete<T>(task: LlmTask<T>): Promise<T> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: this.opts.effort ?? "high",
        format: betaZodOutputFormat(task.schema),
      },
      system: task.system,
      messages: [{ role: "user", content: task.user }],
    });
    if (response.stop_reason === "refusal") {
      throw new Error(`${task.kind}: the model declined (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`${task.kind}: reply was cut off at max_tokens; use a smaller batch`);
    }
    if (response.parsed_output == null) {
      throw new Error(`${task.kind}: reply did not match the schema`);
    }
    return response.parsed_output as T;
  }
}
