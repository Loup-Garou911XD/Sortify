import type { JobKind, JobView } from "../api/types.ts";

export interface JobContext {
  signal: AbortSignal;
  progress(done: number, total: number): void;
  log(line: string): void;
}

export class JobBusyError extends Error {
  constructor(label: string) {
    super(`Another task is still running: ${label}`);
    this.name = "JobBusyError";
  }
}

const MAX_LOG_LINES = 200;

/**
 * Runs one long task at a time (fetch, enrich, apply) in the background and keeps its state for
 * the UI to poll. One at a time keeps the YouTube quota and API rate limits easy to reason about.
 */
export class JobRunner {
  private seq = 0;
  private job: JobView | null = null;
  private controller: AbortController | null = null;

  current(): JobView | null {
    return this.job && { ...this.job, log: [...this.job.log] };
  }

  start(
    kind: JobKind,
    label: string,
    target: { playlistId?: string; runId?: number },
    task: (ctx: JobContext) => Promise<string>,
  ): JobView {
    if (this.job?.status === "running") throw new JobBusyError(this.job.label);
    const controller = new AbortController();
    const job: JobView = {
      id: ++this.seq,
      kind,
      label,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: null,
      log: [],
      message: null,
      playlistId: target.playlistId ?? null,
      runId: target.runId ?? null,
    };
    this.job = job;
    this.controller = controller;

    const ctx: JobContext = {
      signal: controller.signal,
      progress: (done, total) => {
        job.progress = { done, total };
      },
      log: (line) => {
        job.log.push(line);
        if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
      },
    };

    const finish = (status: JobView["status"], message: string): void => {
      job.status = status;
      job.message = message;
      job.finishedAt = new Date().toISOString();
      this.controller = null;
    };
    // Deferred so a synchronous throw inside `task` still settles the job instead of the request.
    Promise.resolve()
      .then(() => task(ctx))
      .then(
        (message) => finish(controller.signal.aborted ? "cancelled" : "done", message),
        (err: unknown) => finish("failed", err instanceof Error ? err.message : String(err)),
      );
    return this.current() as JobView;
  }

  cancel(): boolean {
    if (!this.controller || this.job?.status !== "running") return false;
    this.controller.abort();
    return true;
  }

  /** Resolves once the current job settles; used by tests and graceful shutdown. */
  async idle(pollMs = 5): Promise<void> {
    while (this.job?.status === "running") await new Promise((r) => setTimeout(r, pollMs));
  }
}
