export type Advisor = {
  id: "ceo" | "cto" | "growth" | "risk";
  role: string;
  title: string;
  focus: string;
  accent: string;
  systemPrompt: string;
};

export type CouncilAdvice = { advisorId: Advisor["id"]; response: string };
export type ModelCouncil = {
  deepseekAnalysis: string;
  qwenAnalysis: string;
  deepseekReview: string;
  qwenReview: string;
};

export type ModelName = "deepseek" | "qwen";
export type ExecutionMode = "single" | "review" | "council";
export type TaskType = "intelligence" | "data" | "document" | "decision";

export type ExecutionResult = {
  mode: "single" | "review";
  primaryModel: ModelName;
  primaryAnalysis: string;
  reviewerModel?: ModelName;
  review?: string;
};

export type RouterRecommendation = {
  taskType: TaskType;
  mode: ExecutionMode;
  primaryModel: ModelName;
  reviewerModel?: ModelName;
  futurePreferred: "GPT" | "Claude" | "Gemini" | "Grok";
  reason: string;
  limitations: string[];
  requiredInfo: string[];
};

export type RouterSessionRecord = {
  task: string;
  recommendation: RouterRecommendation;
  accepted: boolean | null;
  finalMode?: ExecutionMode;
  finalPrimaryModel?: ModelName;
  finalReviewerModel?: ModelName;
};

export type FileContext = {
  fileName: string;
  fileType: "pdf" | "txt" | "md";
  fileSize: number;
  extractedText: string;
  truncated: boolean;
  extractionWarning: string | null;
};

export type MemoryType = "USER_FACT" | "PROJECT_STATE" | "DECISION" | "AI_JUDGMENT" | "UNVERIFIED";
export type MemoryStatus = "CONFIRMED" | "UNVERIFIED" | "SUPERSEDED";

export type MemorySuggestion = {
  id: string;
  name: string;
  type: MemoryType;
  project: string;
  content: string;
  status: MemoryStatus;
  source: string;
  decisionResult: string;
};

export type SharedFactState = {
  version: number;
  currentQuestion: string;
  confirmedFacts: string[];
  pendingInformation: string[];
  modelViews: {
    deepseek: string;
    qwen: string;
  };
  changes: string[];
};

export type SharedFactRound = {
  userInput: string;
  state: SharedFactState;
  createdAt: string;
};

export type SharedFactCase = {
  caseId: string;
  originalQuestion: string;
  currentState: SharedFactState;
  rounds: SharedFactRound[];
  createdAt: string;
  updatedAt: string;
};

export type CouncilResult = {
  advice?: CouncilAdvice[];
  modelCouncil?: ModelCouncil;
  execution?: ExecutionResult;
  fileContext?: FileContext;
  memorySuggestions?: MemorySuggestion[];
  summary: string;
};
export type CouncilRound = CouncilResult & { round: number; addedInformation: string };

const requiredStructure = `必须严格使用以下五个标题，不能省略：
1. 用户已提供的事实
2. 我的判断
3. 我的推测
4. 当前缺失的关键信息
5. 建议行动

证据纪律：
- 只把用户明确说过的内容写入“用户已提供的事实”。
- “我的判断”必须说明其依据；“我的推测”必须明确标注为推测，绝不能写成事实。
- 不得补全用户未提供的信息，不得凭空给出具体数字、概率、阈值或市场数据。
- 数字规则：除五个固定标题的编号，以及用户明确提供的数字外，输出中不得出现任何阿拉伯数字、中文数词、百分比、时间周期、样本量、价格、规模或阈值。不得使用编号子列表；生成前逐项删除这类无依据内容，用不带数字的普通项目符号或概括性语言替代。
- 信息不足时，在“当前缺失的关键信息”中明确写“当前无法确定”，并列出需要用户补充的问题。
- “建议行动”应优先是能减少信息缺口或验证推测的行动。`;

export const advisors: Advisor[] = [
  { id: "ceo", role: "CEO", title: "战略顾问", focus: "方向、优先级与商业模式", accent: "from-violet-500 to-indigo-500", systemPrompt: `你是 CEO / 战略顾问。只判断方向、优先级、机会成本和是否值得做；不要代替 CTO、市场或风险顾问。${requiredStructure}` },
  { id: "cto", role: "CTO", title: "技术顾问", focus: "最小实现与技术风险", accent: "from-cyan-500 to-blue-500", systemPrompt: `你是 CTO / 技术顾问。只判断实现难度、MVP 范围、技术约束和资源成本；不要假定任何技术栈、团队能力或预算。${requiredStructure}` },
  { id: "growth", role: "GROWTH", title: "市场顾问", focus: "定位、传播与增长实验", accent: "from-amber-400 to-orange-500", systemPrompt: `你是 Growth / 市场顾问。只判断真实需求、用户动机、获客和验证方式；不要虚构用户规模、转化率或渠道效果。${requiredStructure}` },
  { id: "risk", role: "RISK", title: "风险顾问", focus: "假设、成本与潜在盲点", accent: "from-rose-500 to-pink-500", systemPrompt: `你是 Risk / 风险顾问。你会收到 CEO、CTO 和 Growth 顾问的意见。必须在“我的判断”中点名挑战至少一位顾问的一项具体结论，指出其假设、漏洞或证据不足；如果没有可挑战处，也必须说明“当前无法确定是否存在有效挑战”及原因。不要只做补充。${requiredStructure}` },
];

export const examplePrompt = "我想做一个帮助独立开发者快速验证产品创意的工具，应该从哪里开始？";
