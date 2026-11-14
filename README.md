# UY · 共享背景板

同一个问题，让 DeepSeek 和 Qwen 看到同一份「已确认事实」，各自独立回答，页面并排流式展示，用来对照分歧。

## 这是什么，不是什么

- 是原型：双模型共享事实、多轮更新、待确认问题的生命周期整理、浏览器内的历史记录，并做过真实模型的端到端验证。
- 不是成品：尚未证明双模型比单模型的决策质量更高，也没有接入真实业务数据。
- 当前为演示模式（`src/lib/demo-mode.ts`）：不联网搜索，不生成来源引用。模型输出可能含未核实内容，不能当作事实。
- 历史只保存在访问者自己浏览器的 localStorage 中，没有账号和云端存储。请勿输入敏感信息，输入内容会发送给 DeepSeek 与 Qwen。

## 本地运行

复制 `.env.example` 为 `.env.local` 并填入密钥。`ACCESS_CODE` 是全站共享访问码（浏览器弹窗输入，用户名任意），生产环境必须设置，否则站点返回 503。

```bash
npm install
npm run dev
node --test tests/*.test.mjs
```

PDF 解析用本机 Python（pypdf），默认调用 `python3`；如果解释器不在 PATH 上或没装 pypdf，用环境变量 `PDF_PYTHON_BIN` 指定具体路径。

