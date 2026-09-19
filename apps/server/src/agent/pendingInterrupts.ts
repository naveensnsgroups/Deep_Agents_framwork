import type { ActionRequest, ClientToServerMessage, ReviewConfig } from "@deepagents-ide/shared";
import { toResumeDecisions } from "./decisions.js";
import { isAskUserRequest, MAX_ANSWER_CHARS, type AskUserAnswer } from "./askUser.js";

/** Something the run is paused on until the user answers it. */
export type PendingInterrupt =
  | { id: string; kind: "approval"; actionRequests: ActionRequest[]; reviewConfigs: ReviewConfig[] }
  | { id: string; kind: "question"; question: string; options: string[] };

interface SnapshotLike {
  tasks?: Array<{ interrupts?: Array<{ id?: string; value?: unknown }> }>;
}

function isApprovalRequest(value: unknown): value is { actionRequests: ActionRequest[]; reviewConfigs: ReviewConfig[] } {
  const v = value as { actionRequests?: unknown; reviewConfigs?: unknown } | null;
  return typeof v === "object" && v !== null && Array.isArray(v.actionRequests) && Array.isArray(v.reviewConfigs);
}

/**
 * Every interrupt the thread is paused on, read from its checkpointed state. There can be several
 * at once: subagents launched in parallel each pause separately, and each one is listed here
 * with its own id — including those raised inside a subagent.
 */
export function pendingInterrupts(snapshot: SnapshotLike): PendingInterrupt[] {
  const pending: PendingInterrupt[] = [];
  const seen = new Set<string>();
  for (const task of snapshot.tasks ?? []) {
    for (const { id, value } of task.interrupts ?? []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (isAskUserRequest(value)) {
        pending.push({ id, kind: "question", question: value.question, options: value.options ?? [] });
      } else if (isApprovalRequest(value)) {
        pending.push({ id, kind: "approval", actionRequests: value.actionRequests, reviewConfigs: value.reviewConfigs });
      }
    }
  }
  return pending;
}

type AnswerMessage = Extract<ClientToServerMessage, { type: "resume_decisions" | "answer_question" }>;

export const NOT_WAITING = "That request is no longer waiting for an answer.";

/**
 * Collects the user's answers until every pending interrupt has one, then gives the value to
 * resume with — keyed by interrupt id.
 *
 * Keyed because LangGraph hands a plain resume value to every pending interrupt at once. With
 * two subagents paused in parallel, approving the one card on screen used to approve the other
 * write too, unseen (reproduced before this was written). Resuming only once all are answered
 * also means no request is left behind for a run that has already moved on.
 */
export class AnswerCollector {
  private readonly answers = new Map<string, unknown>();

  constructor(private pending: PendingInterrupt[] = []) {}

  get waiting(): PendingInterrupt[] {
    return this.pending;
  }

  reset(pending: PendingInterrupt[] = []): void {
    this.pending = pending;
    this.answers.clear();
  }

  /** Validates and records one answer. Returns the resume value once nothing is left unanswered. */
  record(msg: AnswerMessage): Record<string, unknown> | undefined {
    const target = this.pending.find((p) => p.id === msg.interruptId);
    if (!target) throw new Error(NOT_WAITING);

    if (msg.type === "resume_decisions") {
      if (target.kind !== "approval") throw new Error(NOT_WAITING);
      const decisions = toResumeDecisions(msg.decisions);
      if (decisions.length !== target.actionRequests.length) throw new Error("Invalid approval response.");
      this.answers.set(target.id, { decisions });
    } else {
      if (target.kind !== "question") throw new Error(NOT_WAITING);
      if (typeof msg.answer !== "string" || !msg.answer.trim()) throw new Error("The answer is empty.");
      if (msg.answer.length > MAX_ANSWER_CHARS) throw new Error(`The answer is too long — keep it under ${MAX_ANSWER_CHARS} characters.`);
      this.answers.set(target.id, { answer: msg.answer.trim() } satisfies AskUserAnswer);
    }

    if (this.pending.some((p) => !this.answers.has(p.id))) return undefined;
    const resume = Object.fromEntries(this.answers);
    this.reset();
    return resume;
  }
}
