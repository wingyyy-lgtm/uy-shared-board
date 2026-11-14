// Wire format for POST /api/shared-analysis when `stream: true`.
// Client-safe: types and labels only, no server imports.

import type { SharedFactState } from "./council";
import type { AdvisorSearchReports } from "./search-plan";

export type ModelName = "deepseek" | "qwen";
export type ModelErrorCode = "timeout" | "auth" | "rate-limit" | "upstream" | "http" | "network" | "evidence" | "failed";

export type ModelFailure = { code: ModelErrorCode; message: string };

export type AnalysisStreamEvent =
  | { type: "stage"; model: ModelName; label: string }
  | { type: "reset"; model: ModelName }
  | { type: "delta"; model: ModelName; text: string }
  | { type: "model-done"; model: ModelName; view: string; truncated?: boolean; elapsedMs: number }
  | { type: "model-error"; model: ModelName; code: ModelErrorCode; message: string }
  | {
      type: "done";
      state: SharedFactState;
      receivedState: { deepseek: string; qwen: string };
      searchReport: AdvisorSearchReports;
      errors: Partial<Record<ModelName, ModelFailure>>;
      elapsedMs: number;
    }
  | { type: "error"; message: string; errors?: Partial<Record<ModelName, ModelFailure>> };

export const MODEL_LABELS: Record<ModelName, string> = { deepseek: "DeepSeek", qwen: "Qwen" };
