/**
 * 門神錢包 Guardian Wallet — 單一型別契約
 *
 * 每個里程碑之間唯一的介面。任何一層做不完，前一層仍是完整可交件的產品。
 *   parser → PaymentIntent → risk → RiskAssessment → policy → PolicyDecision → executor → Payment
 * 全程寫入 AuditEvent。
 */

// ---------------------------------------------------------------------------
// 收款人與政策
// ---------------------------------------------------------------------------

export type PayeeKind =
  | 'utility'
  | 'telecom'
  | 'medical'
  | 'care'
  | 'subscription'
  | 'person'
  | 'unknown';

export type Payee = {
  id: string; // "payee_taipower"
  name: string; // "台灣電力公司"
  address: `0x${string}`; // 鏈上地址（demo 用 Hardhat 帳戶 #5–#13）
  kind: PayeeKind;
  allowlisted: boolean;
  typicalAmount?: number; // 歷史中位數，供金額突增判斷
  aliases?: string[]; // 解析後比對用的別名，例「台電」「電費」
};

/** 守護者設定、合約強制執行的支出規則。LLM 永遠不能修改這個物件。 */
export type Policy = {
  perTxCap: number; // 單筆上限，例 3000
  dailyCap: number; // 單日上限，例 5000
  monthlyCap?: number;
  approvalThreshold: number; // 超過就轉人工核准，例 2000
  newPayeeRequiresApproval: boolean;
  newPayeeCooldownHours: number; // 新收款人冷卻期，例 24
  quietHours?: [number, number]; // [22, 7] 深夜不自動付
  allowlist: string[]; // payee ids
};

// ---------------------------------------------------------------------------
// Payment Intent
//
// 六個受管欄位（taskId / resource / merchant / maxAmount / assetNetwork /
// expiresAt）把 LLM 的推理綁到可驗證的參數上：模型只能在這個信封裡動作，
// 信封本身由政策引擎產生、由合約驗證。對應國泰 x402 演講的授權模型。
// ---------------------------------------------------------------------------

export type IntentSource = 'image' | 'text' | 'message' | 'voice';

export type PaymentIntent = {
  id: string;
  source: IntentSource;
  kind: 'bill' | 'transfer';
  payeeName: string;
  payeeId?: string; // match 後填入
  amount: number; // TWD 整數
  dueDate?: string;
  category: string;
  rawText: string; // OCR / 原文，供風險分析
  confidence: number; // 0–1

  // ---- 受管授權欄位 ----
  /**
   * x402 的三種 scheme（演講 Slide 14）裡我們選 exact。
   *
   * 帳單金額在授權前就是已知且固定的，沒有「用多少算多少」的計量問題，
   * 所以不需要 upto。maxAmount 存在的理由不是計量，是**政策天花板**：
   * 模型讀錯數字時，授權額度不會跟著錯。
   *
   * 而且讀到的金額若超過天花板，不是靜靜照天花板付（那等於付一筆沒人要求的
   * 金額），是停下來問家人 —— 所以結算金額永遠等於信封裡寫的那一個數字，
   * 這才配叫 exact。
   */
  scheme: 'exact';
  taskId: string; // "bill-2026-09-taipower"，一個任務一個 id
  resource: string; // 付的是什麼："電費 2026-09"；x402 情境下是 URL
  merchant: string; // payeeId 解析後的正式名稱
  maxAmount: number; // 政策上限 = min(amount, perTxCap)
  assetNetwork: string; // "tTWD@eip155:84532"
  expiresAt: string; // ISO，短效 15 分鐘；過期不執行、不重付
  idempotencyKey: `0x${string}`; // keccak256 → 鏈上 memoHash，防重放
};

// ---------------------------------------------------------------------------
// 風險評估
// ---------------------------------------------------------------------------

export type RiskSignalCode =
  | 'BLOCKLIST_HIT'
  | 'PROMPT_INJECTION'
  | 'NOT_ALLOWLISTED'
  | 'AUTHORITY_IMPERSONATION'
  | 'URGENCY'
  | 'INVESTMENT_GUARANTEE'
  | 'FAMILY_EMERGENCY'
  | 'SECRECY'
  | 'OVER_THRESHOLD'
  | 'AMOUNT_SPIKE'
  | 'SUSPICIOUS_LINK'
  | 'OFF_HOURS'
  | 'NEW_PAYEE';

export type RiskSignal = {
  code: RiskSignalCode;
  weight: number;
  evidence: string; // 命中的原文片段，UI 要能標出來
};

export type RiskLevel = 'low' | 'medium' | 'high';

export type ScamType =
  | 'impersonation'
  | 'investment'
  | 'family_emergency'
  | 'phishing'
  | 'none';

export type RiskAssessment = {
  level: RiskLevel;
  score: number; // 0–100，rules 與 llm 各半
  rulesScore: number;
  llmScore: number;
  signals: RiskSignal[];
  scamType?: ScamType;
  guardianExplanation: string; // 家人看的完整理由
  elderExplanation: string; // 阿嬤聽的一句話，≤ 40 字、無術語
};

// ---------------------------------------------------------------------------
// 政策決策
// ---------------------------------------------------------------------------

export type PolicyAction = 'auto' | 'hold' | 'block';

export type PolicyDecision = {
  action: PolicyAction;
  rulesHit: string[]; // "NEW_PAYEE_REQUIRES_APPROVAL" 等
  reason: string;
};

// ---------------------------------------------------------------------------
// 付款與稽核
// ---------------------------------------------------------------------------

export type PaymentStatus =
  | 'scheduled'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'blocked'
  | 'failed';

export type ChainMode = 'mock' | 'local' | 'testnet';

export type Payment = {
  id: string;
  intentId: string;
  payee: Payee;
  amount: number;
  memoHash: `0x${string}`; // = intent.idempotencyKey
  status: PaymentStatus;
  channel: ChainMode;
  proposalId?: number; // 鏈上 proposal id
  txHash?: `0x${string}`;
  explorerUrl?: string;
  revertReason?: string; // 紅隊按鈕用
  createdAt: string;
  executedAt?: string;
};

export type AuditEventType =
  | 'intent.received'
  | 'intent.parsed'
  | 'risk.assessed'
  | 'policy.decided'
  | 'payment.executed'
  | 'payment.proposed'
  | 'payment.approved'
  | 'payment.rejected'
  | 'payment.blocked'
  | 'payment.reverted'
  | 'guardian.notified'
  | 'policy.updated';

export type AuditEvent = {
  /** 從 1 開始的序號。鏈斷掉時要能指出「斷在第幾筆」。 */
  seq: number;
  id: string;
  ts: string;
  type: AuditEventType;
  actor: 'agent' | 'guardian' | 'elder' | 'chain';
  intentId?: string;
  paymentId?: string;
  summary: string;
  details: Record<string, unknown>;
  memoHash?: `0x${string}`;

  // ---- 雜湊鏈 ----
  //
  // 純附加寫入的日誌不算證據，因為門神自己就能改。每一筆把前一筆的雜湊
  // 包進自己的雜湊裡，改動任何一筆，之後所有的雜湊都對不上。
  // 這不是防竄改（本機檔案擋不住 root），是**讓竄改留下痕跡**。
  /** 前一筆的 hash；第一筆是 0x00…00。 */
  prevHash: `0x${string}`;
  /** keccak256(這一筆的正規化內容 + prevHash)。 */
  hash: `0x${string}`;
};

// ---------------------------------------------------------------------------
// Agent 思考軌跡
// ---------------------------------------------------------------------------

export type TracePhase = 'observe' | 'plan' | 'tool' | 'verify';

export type TraceStep = {
  t: string; // ISO 時間戳
  phase: TracePhase;
  tool?: string; // "match_payee" / "assess_risk" / "chain.pay"
  detail: string;
};

// ---------------------------------------------------------------------------
// 帳務分析（沿用帳房先生引擎，供週報使用）
// ---------------------------------------------------------------------------

export type Transaction = {
  id: string;
  date: string; // ISO date
  merchant: string;
  amount: number; // 正數 = 支出，TWD
  category: string;
  recurring: boolean;
  note?: string;
  source?: 'demo' | 'text' | 'image';
};

export type PendingBill = {
  id: string;
  payeeId?: string;
  merchant: string;
  amount: number;
  dueDate: string;
  category: string;
  status: 'unpaid' | 'paid';
  image?: string; // demo-data 內的檔名，幕一用
};

export type FindingType =
  | 'duplicate_charge'
  | 'zombie_subscription'
  | 'price_hike'
  | 'due_soon';

export type Finding = {
  id: string;
  type: FindingType;
  title: string;
  merchant: string;
  impactMonthly: number;
  confidence: number; // 0–1
  evidence: {
    txIds: string[];
    /** 哪一條規則、依據什麼判的。給人看的完整句子。 */
    rule: string;
    /** 模型的補充說明。異常偵測是純規則的（M5.1），所以通常沒有。 */
    llmReason?: string;
  };
};

export type WeeklyReport = {
  month: string; // "2026-09"
  totalSpend: number;
  byCategory: { category: string; amount: number }[];
  blockedAmount: number; // 攔下的詐騙金額
  savedAmount: number; // 異常省下的金額
  guardedTotal: number; // blockedAmount + savedAmount，週報頭條數字
  findings: Finding[];
  paymentsExecuted: number;
  narrative: string; // 給 ElevenLabs 唸的中文口語
  audioUrl?: string;
};

// ---------------------------------------------------------------------------
// Demo 劇本
// ---------------------------------------------------------------------------

export type ScenarioId =
  | 'electricity'
  | 'scam_nhi'
  | 'redpacket'
  | 'weekly_report'
  | 'scam_investment'
  | 'scam_grandchild';

export type DemoScenario = {
  id: ScenarioId;
  title: string;
  input: { type: 'image' | 'text'; value: string }; // image = demo-data 內的檔名
  expected: {
    action: PolicyAction;
    riskLevel: RiskLevel;
    amount?: number;
  };
};

export type DemoPersona = {
  elder: { name: string; age: number };
  guardian: { name: string; relation: string };
};

/** 模擬的 165 高風險帳戶名單。真實版接打詐儀錶板開放資料。 */
export type BlocklistEntry = {
  account: string;
  source: string;
  note: string;
};

export type DemoMessage = {
  id: string;
  type: 'scam' | 'legit';
  from: string;
  text: string;
  receivedAt: string;
};

/** 收款人最後使用時間，殭屍訂閱規則要用。 */
export type UsageRecord = {
  payeeId: string;
  lastUsed: string;
};

/**
 * 四幕跑完後週報應該顯示的數字。`guardedTotal` 是頭條。
 * 調價只報不加總（錢還沒真的省下來，要家人去談），所以不計入 guardedTotal。
 */
export type ExpectedReport = {
  blockedScam: number;
  duplicateRefund: number;
  zombieCancel: number;
  priceHikeDelta: number;
  guardedTotal: number;
};

export type DemoData = {
  persona: DemoPersona;
  policy: Policy;
  payees: Payee[];
  blocklist: BlocklistEntry[];
  transactions: Transaction[];
  usage: UsageRecord[];
  pendingBills: PendingBill[];
  messages: DemoMessage[];
  scenarios: DemoScenario[];
  expectedReport: ExpectedReport;
};
