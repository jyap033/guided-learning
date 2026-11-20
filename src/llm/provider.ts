import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

/** One structured AI request. The output must validate against `schema` (D-009). */
export interface LlmTask<T> {
  /** Short name of the pipeline step, e.g. "extract". Used in logs and cache files. */
  kind: string;
  /** Bump when the prompt changes, so cached answers for the old prompt are ignored. */
  promptVersion: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
}

export interface LlmProvider {
  /** Name recorded in outputs, e.g. "claude-code" or "anthropic-api:claude-opus-5-5". */
  readonly name: string;
  complete<T>(task: LlmTask<T>): Promise<T>;
}

export function taskId(task: LlmTask<unknown>): string {
  return crypto
    .createHash("sha256")
    .update([task.kind, task.promptVersion, task.system, task.user].join("\u0000"))
    .digest("hex")
    .slice(0, 20);
}

/** JSON Schema for a zod schema, as sent to the model. */
export function jsonSchemaFor(schema: z.ZodType<unknown>): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/**
 * Wraps a provider with an on-disk cache of validated answers, keyed by the
 * hash of the prompt. Re-running the pipeline costs nothing unless a prompt
 * or its input changed.
 */
export class CachedProvider implements LlmProvider {
  readonly name: string;
  calls = 0;
  hits = 0;
  private used = new Set<string>();

  constructor(
    private inner: LlmProvider,
    private dir: string,
    private log: (msg: string) => void = () => {},
  ) {
    this.name = inner.name;
  }

  async complete<T>(task: LlmTask<T>): Promise<T> {
    const id = taskId(task);
    const file = path.join(this.dir, `${task.kind}-${id}.json`);
    this.used.add(path.basename(file));
    if (fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, "utf8")) as { output: unknown };
      const parsed = task.schema.safeParse(cached.output);
      if (parsed.success) {
        this.hits++;
        return parsed.data;
      }
      this.log(`cache entry ${path.basename(file)} no longer matches its schema; asking again`);
    }
    this.calls++;
    const started = Date.now();
    const output = await this.inner.complete(task);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        { kind: task.kind, promptVersion: task.promptVersion, provider: this.inner.name, output },
        null,
        2,
      ) + "\n",
    );
    this.log(`${task.kind} ${id} answered in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    return output;
  }

  /**
   * Delete cached answers of the given task kinds that this run didn't use
   * (stale prompts or inputs). Returns how many were removed.
   */
  pruneUnused(kinds: string[]): number {
    if (!fs.existsSync(this.dir)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(this.dir)) {
      const kind = f.slice(0, f.lastIndexOf("-"));
      if (f.endsWith(".json") && kinds.includes(kind) && !this.used.has(f)) {
        fs.rmSync(path.join(this.dir, f));
        n++;
      }
    }
    return n;
  }
}

/** Run async jobs with at most `limit` in flight. Results keep input order. */
export async function mapLimit<I, O>(items: I[], limit: number, fn: (item: I, i: number) => Promise<O>): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as I, i);
    }
  });
  await Promise.all(workers);
  return results;
}
