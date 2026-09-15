import type { ActionRequest, ReadProvenance, ReviewConfig, ToolResultInfo } from "@deepagents-ide/shared";

export type Decision =
  | { type: "approve" }
  | { type: "reject"; message?: string }
  | { type: "edit"; editedAction: { name: string; args: Record<string, unknown> } };

export type TimelineItem =
  | { kind: "user"; id: string; content: string; userIndex: number; timestamp: number }
  | { kind: "agent"; id: string; content: string; timestamp: number }
  | { kind: "tool"; id: string; results: ToolResultInfo[] }
  | {
      kind: "interrupt";
      id: string;
      actionRequests: ActionRequest[];
      reviewConfigs: ReviewConfig[];
      /** What the agent read just before proposing this — see ProvenancePanel. */
      provenance: ReadProvenance[];
      resolved: boolean;
    }
  | { kind: "status"; id: string; content: string }
  | { kind: "error"; id: string; content: string };
