import type { ActionRequest, ReadProvenance, ReviewConfig, ReviewDecision, SubagentStatus, ToolResultInfo } from "@deepagents-ide/shared";

export type Decision = ReviewDecision;

export type TimelineItem =
  | { kind: "user"; id: string; content: string; userIndex: number; timestamp: number }
  | { kind: "agent"; id: string; content: string; timestamp: number }
  | { kind: "tool"; id: string; results: ToolResultInfo[] }
  | {
      kind: "interrupt";
      /** The server's interrupt id, which the answer is sent back with. */
      id: string;
      actionRequests: ActionRequest[];
      reviewConfigs: ReviewConfig[];
      /** What the agent read just before proposing this — see ProvenancePanel. */
      provenance: ReadProvenance[];
      resolved: boolean;
      /** How it was resolved, shown on the collapsed card. Unset while pending. */
      decision?: Decision;
    }
  | {
      kind: "question";
      /** The server's interrupt id, which the answer is sent back with. */
      id: string;
      question: string;
      options: string[];
      /** Set once answered. */
      answer?: string;
    }
  | {
      kind: "subagent";
      /** The `task` call's id. */
      id: string;
      subagent: string;
      description: string;
      /** "stopped" when the turn ended while it was still running (Stop, an error, a dropped connection). */
      status: "running" | SubagentStatus | "stopped";
      /** Tools it has called, oldest first, capped. */
      activity: Array<{ tool: string; target?: string }>;
      /** Tool calls made, including any dropped from `activity` by the cap. */
      steps: number;
    }
  | { kind: "status"; id: string; content: string }
  | { kind: "error"; id: string; content: string };
