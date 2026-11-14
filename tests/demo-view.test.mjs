import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8") + "\nexport { ModelView };";
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const textOf = node => node == null ? "" : typeof node !== "object" ? String(node) : Array.isArray(node) ? node.map(textOf).join("") : textOf(node.props?.children);
test("demo hides old evidence without changing stored view; disabling switch restores it", () => {
  const value = "【当前判断】保留判断\n【我查到的证据】\n[S1] 旧来源\n【全部搜索结果】隐藏搜索\n【关键未知信息】保留问题";
  for (const demoMode of [true, false]) {
    const mod = { exports: {} };
    runInNewContext(code, { module: mod, exports: mod.exports, require(name) {
      if (name === "react") return {};
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name.endsWith("/demo-mode")) return { DEMO_MODE: demoMode };
      if (name.endsWith("/live-panel")) return { LivePanel: () => null };
      if (name.endsWith("/sse-client")) return { readAnalysisStream: async () => {} };
      throw new Error(name);
    } });
    const displayed = textOf(mod.exports.ModelView({ value }));
    assert.match(displayed, /保留判断/);
    assert.match(displayed, /保留问题/);
    if (demoMode) assert.doesNotMatch(displayed, /旧来源|搜索|我查到的证据|\[S1\]/);
    else assert.match(displayed, /旧来源/);
  }
});
