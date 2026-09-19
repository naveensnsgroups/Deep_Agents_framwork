import type { HITLResponse } from "langchain";
import type { ReviewDecision } from "@deepagents-ide/shared";

/** A reason is a sentence or a short paragraph; anything longer is almost certainly a paste. */
export const MAX_REASON_CHARS = 2000;

/**
 * What the model reads in place of the tool's result when the user denies it. The
 * human-in-the-loop middleware puts this text in an error ToolMessage and sends the model
 * straight back to work, so it is the model's only clue about what to do differently. The
 * library's own default ("User rejected the tool call for `x` with id y") says nothing about
 * what to do next, and models tend to retry the same action unchanged.
 */
export function rejectionMessage(reason?: string): string {
  const denied = "The user denied this action, so it was not run.";
  const trimmed = reason?.trim();
  if (!trimmed) {
    return `${denied} Do not retry it unchanged. If it is unclear why it was denied or how to continue, ask the user.`;
  }
  return `${denied} Their reason:\n${trimmed}\nFollow this when deciding what to do next.`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns the decisions a client sent into what the middleware resumes with. The WebSocket is
 * untrusted input, and a malformed decision would otherwise surface from deep inside the graph
 * as a confusing error after the run has already resumed.
 */
export function toResumeDecisions(input: unknown): HITLResponse["decisions"] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Invalid approval response.");

  return input.map((raw): HITLResponse["decisions"][number] => {
    const decision = raw as ReviewDecision;
    if (!isPlainObject(decision)) throw new Error("Invalid approval response.");

    if (decision.type === "approve") return { type: "approve" };

    if (decision.type === "reject") {
      if (decision.reason !== undefined && typeof decision.reason !== "string") throw new Error("Invalid approval response.");
      if ((decision.reason?.length ?? 0) > MAX_REASON_CHARS) {
        throw new Error(`The reason is too long — keep it under ${MAX_REASON_CHARS} characters.`);
      }
      return { type: "reject", message: rejectionMessage(decision.reason) };
    }

    if (decision.type === "edit") {
      const edited = decision.editedAction;
      if (!isPlainObject(edited) || typeof edited.name !== "string" || !isPlainObject(edited.args)) {
        throw new Error("Invalid approval response.");
      }
      return { type: "edit", editedAction: { name: edited.name, args: edited.args } };
    }

    throw new Error("Invalid approval response.");
  });
}
