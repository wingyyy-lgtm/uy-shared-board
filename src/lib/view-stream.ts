// Turns a raw model response into the display text we want to stream into a
// column. Two shapes are supported:
//   - plain text (the usual case): forwarded as-is;
//   - a JSON object whose first interesting field is "view": only the decoded
//     view string is forwarded, so the reader never sees JSON punctuation.
// The extractor tolerates the string, its escapes and Unicode escapes being
// split across arbitrary chunk boundaries.

type Mode = "undetermined" | "text" | "json";

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

export class ViewTextStream {
  private mode: Mode = "undetermined";
  private raw = "";
  private textEmitted = 0;
  private fenceHandled = false;

  // JSON mode state.
  private scanFrom = 0;
  private viewStart = -1;
  private decodeFrom = 0;
  private escaped = false;
  private closed = false;
  private highSurrogate: string | null = null;

  push(chunk: string): string {
    if (!chunk) return "";
    this.raw += chunk;
    if (this.mode === "undetermined") this.detect();
    if (this.mode === "text") return this.drainText();
    if (this.mode === "json" && !this.closed) return this.decodeView();
    return "";
  }

  finish(): string {
    if (this.mode === "text") return this.drainText();
    if (this.mode === "json" && !this.closed) {
      this.closed = true;
      return this.decodeView();
    }
    return "";
  }

  private drainText() {
    const out = this.raw.slice(this.textEmitted);
    this.textEmitted = this.raw.length;
    return out;
  }

  private detect() {
    let start = this.raw.replace(/^\s+/, "");
    if (!start) return;
    // Some models wrap JSON in a ```json fence. Wait for the whole fence line
    // before deciding, otherwise a partial fence would look like plain text.
    if (!this.fenceHandled && start.startsWith("`")) {
      const newline = start.indexOf("\n");
      if (newline < 0) return;
      const fence = start.slice(0, newline).trimEnd();
      if (/^```(?:json)?$/i.test(fence)) {
        const offset = this.raw.length - start.length + newline + 1;
        this.raw = this.raw.slice(offset);
        this.textEmitted = 0;
        start = this.raw.replace(/^\s+/, "");
      }
      this.fenceHandled = true;
    }
    if (!start) return;
    if (start.startsWith("{")) {
      this.mode = "json";
      this.scanFrom = this.raw.indexOf("{") + 1;
      return;
    }
    this.mode = "text";
    this.textEmitted = this.raw.length - start.length;
  }

  private findViewKey() {
    if (this.viewStart >= 0) return true;
    if (this.raw.length < 8) return false;
    const pattern = /"view"\s*:\s*"/g;
    pattern.lastIndex = Math.max(0, this.scanFrom - 8);
    const match = pattern.exec(this.raw);
    if (!match) {
      this.scanFrom = Math.max(0, this.raw.length - 8);
      return false;
    }
    this.viewStart = match.index + match[0].length;
    this.decodeFrom = this.viewStart;
    this.scanFrom = this.viewStart;
    return true;
  }

  private decodeView(): string {
    if (!this.findViewKey()) return "";
    let out = "";
    while (this.decodeFrom < this.raw.length) {
      const char = this.raw[this.decodeFrom];
      if (this.escaped) {
        if (char === "u") {
          // \uXXXX may be split across chunks; wait for four hex digits.
          if (this.decodeFrom + 5 > this.raw.length) break;
          const hex = this.raw.slice(this.decodeFrom + 1, this.decodeFrom + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += char;
            this.decodeFrom += 1;
            this.escaped = false;
            continue;
          }
          out += this.emitCodeUnit(parseInt(hex, 16));
          this.decodeFrom += 5;
          this.escaped = false;
          continue;
        }
        if (this.highSurrogate) {
          out += this.highSurrogate;
          this.highSurrogate = null;
        }
        out += ESCAPES[char] ?? char;
        this.decodeFrom += 1;
        this.escaped = false;
        continue;
      }
      if (char === "\\") {
        this.escaped = true;
        this.decodeFrom += 1;
        continue;
      }
      if (char === '"') {
        if (this.highSurrogate) {
          out += this.highSurrogate;
          this.highSurrogate = null;
        }
        this.closed = true;
        this.decodeFrom += 1;
        break;
      }
      if (this.highSurrogate) {
        out += this.highSurrogate;
        this.highSurrogate = null;
      }
      out += char;
      this.decodeFrom += 1;
    }
    return out;
  }

  private emitCodeUnit(code: number) {
    if (code >= 0xd800 && code <= 0xdbff) {
      if (this.highSurrogate) return this.highSurrogate + String.fromCharCode(code);
      this.highSurrogate = String.fromCharCode(code);
      return "";
    }
    if (code >= 0xdc00 && code <= 0xdfff && this.highSurrogate) {
      const pair = this.highSurrogate + String.fromCharCode(code);
      this.highSurrogate = null;
      return pair;
    }
    if (this.highSurrogate) {
      const replacement = this.highSurrogate + String.fromCharCode(code);
      this.highSurrogate = null;
      return replacement;
    }
    return String.fromCharCode(code);
  }
}
