import { spawn } from "node:child_process";
import { jsonSchemaFor, type LlmProvider, type LlmTask } from "./provider.ts";

/**
 * Runs each task through Claude Code in headless mode (`claude -p`), which uses
 * the user's existing Claude login: no API key needed (D-007, revised).
 * Tools are disabled; the model only reads the prompt and returns JSON that
 * Claude Code validates against the schema. We validate again with zod.
 */
export class ClaudeCodeProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private opts: { bin?: string; model?: string; timeoutMs?: number; retries?: number } = {},
  ) {
    this.name = `claude-code${opts.model ? `:${opts.model}` : ""}`;
  }

  async complete<T>(task: LlmTask<T>): Promise<T> {
    const retries = this.opts.retries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const raw = await this.runOnce(task);
        const parsed = task.schema.safeParse(raw);
        if (parsed.success) return parsed.data;
        lastError = new Error(`output failed validation: ${parsed.error.message.slice(0, 500)}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`${task.kind}: no valid answer after ${retries + 1} attempts: ${String(lastError)}`);
  }

  private runOnce(task: LlmTask<unknown>): Promise<unknown> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(jsonSchemaFor(task.schema)),
      "--system-prompt",
      task.system,
      "--tools",
      "",
    ];
    if (this.opts.model) args.push("--model", this.opts.model);

    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.bin ?? "claude", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${task.kind}: claude timed out`));
      }, this.opts.timeoutMs ?? 20 * 60 * 1000);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`could not start "claude" (is Claude Code installed and logged in?): ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let result: { is_error?: boolean; structured_output?: unknown; result?: string; subtype?: string };
        try {
          result = JSON.parse(stdout);
        } catch {
          reject(new Error(`claude exited ${code} without JSON output: ${(stderr || stdout).slice(0, 500)}`));
          return;
        }
        if (result.is_error || result.structured_output === undefined) {
          reject(new Error(`claude returned no structured output (${result.subtype}): ${String(result.result).slice(0, 500)}`));
          return;
        }
        resolve(result.structured_output);
      });
      child.stdin.end(task.user);
    });
  }
}
