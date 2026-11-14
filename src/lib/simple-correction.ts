// Deterministic fallback for the common correction shape "不是 X，是 Y".
// The LLM-based resolver is flexible but occasionally returns no match (which
// surfaces as a 422 during a demo). When exactly one confirmed fact contains X,
// we can replace it without asking a model at all.

export type CorrectionResolution = { supersededFacts: string[]; replacementFacts: string[] };

export function parseSimpleCorrection(input: string): { from: string; to: string } | null {
  const match = input.match(/不是\s*([^，。；,;]{1,60}?)\s*[，,]\s*是\s*([^。；;]{1,80}?)\s*[。]?\s*$/);
  if (!match) return null;
  const from = match[1].trim();
  const to = match[2].trim();
  if (!from || !to || from === to) return null;
  return { from, to };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternFor(from: string) {
  const source = escapeRegExp(from)
    .replace(/[0-9]/g, (digit) => `[${digit}${String.fromCharCode(digit.charCodeAt(0) + 0xfee0)}]`)
    .replace(/\s+/g, "\\s*")
    .replace(/[%％]/g, "\\s*[%％]");
  return new RegExp(source, "i");
}

function normalizeFact(value: string) {
  return value
    .replace(/^用户明确提供：/, "")
    .replace(/[\s，。；、,.;：:]/g, "");
}

export function replaceSimpleCorrection(text: string, input: string): string | null {
  const parsed = parseSimpleCorrection(input);
  if (!parsed) return null;
  const pattern = patternFor(parsed.from);
  if (!pattern.test(text)) return null;
  const replaced = text.replace(pattern, parsed.to);
  return replaced === text ? null : replaced;
}

export function mentionsCorrectionTarget(text: string, input: string): boolean {
  const parsed = parseSimpleCorrection(input);
  return parsed ? patternFor(parsed.from).test(text) : false;
}

export function resolveSimpleCorrection(facts: string[], input: string): CorrectionResolution | null {
  const parsed = parseSimpleCorrection(input);
  if (!parsed) return null;
  const pattern = patternFor(parsed.from);
  const matches = facts.filter((fact) => pattern.test(fact));
  if (!matches.length) return null;

  // If the same claim was added twice (e.g. once inside the question and once
  // as a supplement), replace every copy. Different claims that merely share
  // the number stay ambiguous and fall back to the model.
  if (matches.length > 1) {
    const target = normalizeFact(matches[matches.length - 1]);
    if (!matches.every((fact) => normalizeFact(fact) === target)) return null;
  }

  const oldFact = matches[matches.length - 1];
  const replacement = replaceSimpleCorrection(oldFact, input)?.replace(/^用户明确提供：/, "").trim();
  if (!replacement) return null;
  return { supersededFacts: matches, replacementFacts: [replacement] };
}
