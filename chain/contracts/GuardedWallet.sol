// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title GuardedWallet
 * @notice 政策錢包。支出規則寫在這裡，由合約強制執行，不是由應用層自律。
 *
 * 這是整個作品的論點所在。AI 代理只有 operator 這把受限的鑰匙，
 * 就算它被 prompt injection 騙過、就算伺服器被入侵、就算 operator 金鑰外洩，
 * 超出政策的付款依然出不去，而且守護者可以隨時把那把鑰匙換掉。
 *
 * 三個角色：
 *   guardian  家人。根權限，可改政策、核准例外、撤換代理金鑰。
 *   operator  門神 agent。只能在政策範圍內付款，其餘一律回退。
 *   本合約餘額  受限的代理資金。額度用完就是用完，不會波及其他帳戶。
 *
 * 每一筆付款都綁一個 memoHash，就是鏈下 PaymentIntent 的冪等鍵：
 *
 *     memoHash = keccak256(abi.encode(taskIdHash, payee, amount, assetNetworkHash))
 *
 * **而且合約會自己算一遍再比對**（`intentHash`）。這一條 require 是 9/5 補上的，
 * 在那之前 memoHash 只是一把不透明的去重鍵：合約收到就寫進 usedIntent，
 * 從不檢查它是否真的對應這次的收款人與金額 —— 所以
 * `pay(小宇, 3000, 台電那筆的 memoHash)` 會被照付，鏈上留下一筆
 * 對不起來的紀錄，而合約不會察覺。
 *
 * 補上之後能講的是：拿到 operator 金鑰的人，在額度內還是能偷錢
 * （六道 require 擋的是金額，不是身分），但他**沒辦法讓鏈上的紀錄說謊** ——
 * 每一個 PaymentExecuted 事件裡的 memoHash 都可證明地描述了它自己那筆付款。
 * 對應演講 Slide 26：Signatures must bind to one task and purchase。
 *
 * `intentHash` 開成 public pure，任何人都能拿稽核檔裡的四個欄位自己算一次，
 * 跟鏈上事件比對。稽核紀錄因此是可驗證的，不是「我們說了算」。
 *
 * 雜湊的輸入用**收款地址**而不是商家名字。名字不規範（「台電」與
 * 「台灣電力公司」是同一個收款人），而且要丟進 calldata 才算得動；
 * 地址本來就是 pay() 的參數，而且它才是錢真正去的地方。
 *
 * 注意 **`expiresAt` 刻意不在那個雜湊裡**：逾時重試必須拿到同一把鍵，
 * 否則「等太久所以重送」就會變成第二次付款。效期改成獨立的參數，
 * 由下面每一條路徑各自比對 block.timestamp（演講 Slide 29：
 * 逾時代表結果未知，不代表可以再付一次）。
 */
contract GuardedWallet {
    // ─── 角色 ────────────────────────────────────────────────────────────
    address public guardian;
    address public operator;
    IERC20 public immutable token;

    // ─── 政策 ────────────────────────────────────────────────────────────
    struct Policy {
        uint256 perTxCap; // 單筆上限
        uint256 dailyCap; // 單日累計上限
        uint256 approvalThreshold; // 超過就必須走守護者核准
    }

    Policy public policy;

    /// @notice 允許自動付款的收款人。不在名單上的一律要核准。
    mapping(address => bool) public allowlist;

    /// @notice 每日已花金額，鍵是 `dayIndex(block.timestamp)`（台北日，不是 UTC 日）。
    mapping(uint256 => uint256) public spentByDay;

    /// @notice 已結算或已被拒絕的意圖。防重放與冪等都靠這一個對照表。
    mapping(bytes32 => bool) public usedIntent;

    // ─── 提案 ────────────────────────────────────────────────────────────
    enum Status {
        Pending,
        Approved,
        Rejected,
        Executed
    }

    struct Proposal {
        address payee;
        uint256 amount;
        bytes32 memoHash;
        uint256 expiresAt; // 提案自己的效期，核准時要再比一次
        string reason; // 門神給守護者看的建議理由
        Status status;
        uint256 createdAt;
    }

    Proposal[] public proposals;

    // ─── 事件 ────────────────────────────────────────────────────────────
    event PaymentExecuted(
        uint256 indexed proposalId,
        address indexed payee,
        uint256 amount,
        bytes32 indexed memoHash,
        address executedBy
    );
    event PaymentProposed(
        uint256 indexed proposalId,
        address indexed payee,
        uint256 amount,
        bytes32 indexed memoHash,
        string reason
    );
    event PaymentApproved(uint256 indexed proposalId, address indexed approvedBy);
    event PaymentRejected(uint256 indexed proposalId, address indexed rejectedBy, string reason);
    event PolicyUpdated(uint256 perTxCap, uint256 dailyCap, uint256 approvalThreshold);
    event AllowlistUpdated(address indexed payee, bool allowed);
    event OperatorRotated(address indexed previousOperator, address indexed newOperator);

    /// @dev 直接付款不經過提案，用這個哨兵值當 proposalId，事件才不會跟 0 號提案混淆。
    uint256 private constant NO_PROPOSAL = type(uint256).max;

    // ─── 存取控制 ────────────────────────────────────────────────────────
    modifier onlyGuardian() {
        require(msg.sender == guardian, "Unauthorized: guardian only");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "Unauthorized: operator only");
        _;
    }

    constructor(address _guardian, address _operator, IERC20 _token, Policy memory _policy) {
        require(_guardian != address(0), "guardian is zero address");
        require(_operator != address(0), "operator is zero address");
        require(address(_token) != address(0), "token is zero address");

        guardian = _guardian;
        operator = _operator;
        token = _token;
        policy = _policy;

        emit PolicyUpdated(_policy.perTxCap, _policy.dailyCap, _policy.approvalThreshold);
        emit OperatorRotated(address(0), _operator);
    }

    // ─── 日界線 ───────────────────────────────────────────────────────────

    /**
     * @notice 單日上限的時區位移。台北是 UTC+8。
     *
     * @dev 沒有這個位移的話，`block.timestamp / 1 days` 的日界線落在 UTC 午夜，
     *      也就是**台北的早上八點** —— 家人設「單日上限 5,000」，實際生效的窗口
     *      卻是早上八點到隔天早上八點。而鏈下的安靜時段（22–7）用的是台北時間，
     *      同一份政策裡兩種「一天」。
     *
     *      固定 +8 而不是處理真正的時區資料庫：台灣沒有日光節約時間，
     *      而把 tzdata 搬進合約是荒謬的。這個作品的使用者在台灣。
     */
    uint256 private constant TZ_OFFSET = 8 hours;

    /**
     * @notice 某個時間戳落在哪一個「台北日」。`spentByDay` 的鍵。
     *
     * @dev 開成 public pure 的理由跟 `intentHash` 一樣：鏈下的 `dayIndex()`
     *      要算出同一個數字才讀得到正確的桶，有個權威定義可以對照。
     */
    function dayIndex(uint256 ts) public pure returns (uint256) {
        return (ts + TZ_OFFSET) / 1 days;
    }

    // ─── 意圖雜湊 ─────────────────────────────────────────────────────────

    /**
     * @notice 由付款內容算出 memoHash。鏈下的 `buildIdempotencyKey()` 算的是同一個東西。
     *
     * @dev 開成 public pure 是刻意的：評審拿稽核檔裡的
     *      (taskId, 收款地址, 金額, assetNetwork) 就能自己算一次，跟鏈上事件比對。
     *      沒有這一個進入點，「稽核可驗證」就只是我們自己的說法。
     *
     *      字串先在鏈下雜湊成 bytes32 再送進來 —— 中文商家名與 CAIP-2 字串
     *      丟進 calldata 又貴又難規範。用 abi.encode 而不是 encodePacked：
     *      每個欄位固定佔 32 bytes，不會出現「兩組不同輸入接出同一串」的邊界問題。
     *
     *      **expiresAt 不在裡面**，理由見檔頭。
     */
    function intentHash(address payee, uint256 amount, bytes32 taskIdHash, bytes32 assetNetworkHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(taskIdHash, payee, amount, assetNetworkHash));
    }

    // ─── 付款 ────────────────────────────────────────────────────────────

    /**
     * @notice 門神在政策範圍內直接付款。六道檢查全部在鏈上。
     *
     * @dev 回退訊息就是畫面上顯示給評審看的字串，鏈下的 mock adapter 也照抄同一份，
     *      不要改。順序也是刻意的：先擋最便宜、最確定的（效期、重放），
     *      再擋要讀 policy 的。
     *
     *      狀態全部寫在 transfer 之前（checks-effects-interactions）。
     *      這樣就算代幣合約在 transfer 裡回頭呼叫 pay，第二次也會撞上
     *      usedIntent 而回退 —— 重入拿不到第二筆錢。
     */
    function pay(
        address payee,
        uint256 amount,
        bytes32 memoHash,
        bytes32 taskIdHash,
        bytes32 assetNetworkHash,
        uint256 expiresAt
    ) external onlyOperator {
        require(
            memoHash == intentHash(payee, amount, taskIdHash, assetNetworkHash),
            "IntentMismatch: memo does not describe this payment"
        );
        require(block.timestamp <= expiresAt, "PolicyViolation: intent expired");
        require(!usedIntent[memoHash], "Replay: intent already settled");
        require(allowlist[payee], "PolicyViolation: payee not allowlisted");
        require(amount <= policy.perTxCap, "PolicyViolation: per-tx cap exceeded");
        require(amount <= policy.approvalThreshold, "PolicyViolation: guardian approval required");

        uint256 day = dayIndex(block.timestamp);
        require(spentByDay[day] + amount <= policy.dailyCap, "PolicyViolation: daily cap exceeded");

        usedIntent[memoHash] = true;
        spentByDay[day] += amount;

        require(token.transfer(payee, amount), "transfer failed");
        emit PaymentExecuted(NO_PROPOSAL, payee, amount, memoHash, msg.sender);
    }

    /**
     * @notice 超出政策的付款改走提案，等守護者決定。
     *
     * @dev 這裡不動錢，也不燒冪等鍵 —— 提案還沒結算，鍵要留到核准的那一刻。
     *      但已經結算或已經被拒絕過的意圖不接受再提案，否則被拒絕的東西
     *      只要代理重送一次就能重新排隊。
     */
    function propose(
        address payee,
        uint256 amount,
        bytes32 memoHash,
        bytes32 taskIdHash,
        bytes32 assetNetworkHash,
        uint256 expiresAt,
        string calldata reason
    ) external onlyOperator returns (uint256 proposalId) {
        require(
            memoHash == intentHash(payee, amount, taskIdHash, assetNetworkHash),
            "IntentMismatch: memo does not describe this payment"
        );
        require(payee != address(0), "payee is zero address");
        require(amount > 0, "amount is zero");
        require(block.timestamp <= expiresAt, "PolicyViolation: intent expired");
        require(!usedIntent[memoHash], "Replay: intent already settled");
        require(amount <= policy.perTxCap, "PolicyViolation: per-tx cap exceeded");

        proposalId = proposals.length;
        proposals.push(
            Proposal({
                payee: payee,
                amount: amount,
                memoHash: memoHash,
                expiresAt: expiresAt,
                reason: reason,
                status: Status.Pending,
                createdAt: block.timestamp
            })
        );

        emit PaymentProposed(proposalId, payee, amount, memoHash, reason);
    }

    /**
     * @notice 守護者核准提案並立即結算。
     *
     * @dev 核准跳過兩道：**白名單**與**核准門檻**。
     *      家人核准的是「這一個收款人、這一個金額」，那個動作本身就是授權來源 ——
     *      不然新收款人永遠付不出去，而「新收款人要家人點頭」正是設計本意。
     *
     *      不跳過的：效期、防重放、單筆上限、單日上限。
     *      家人能同意一筆付款，不能解除長期的硬上限；要那樣得先 setPolicy。
     *
     *      效期那一條特別重要：家人半夜醒來看到通知按下去，過期的提案不會付出去。
     */
    function approve(uint256 proposalId) external onlyGuardian {
        require(proposalId < proposals.length, "no such proposal");
        Proposal storage p = proposals[proposalId];

        require(p.status == Status.Pending, "proposal is not pending");
        require(block.timestamp <= p.expiresAt, "PolicyViolation: intent expired");
        require(!usedIntent[p.memoHash], "Replay: intent already settled");
        require(p.amount <= policy.perTxCap, "PolicyViolation: per-tx cap exceeded");

        uint256 day = dayIndex(block.timestamp);
        require(
            spentByDay[day] + p.amount <= policy.dailyCap, "PolicyViolation: daily cap exceeded"
        );

        usedIntent[p.memoHash] = true;
        spentByDay[day] += p.amount;
        p.status = Status.Executed;

        require(token.transfer(p.payee, p.amount), "transfer failed");

        emit PaymentApproved(proposalId, msg.sender);
        emit PaymentExecuted(proposalId, p.payee, p.amount, p.memoHash, msg.sender);
    }

    /**
     * @notice 守護者拒絕提案。
     *
     * @dev 拒絕會把冪等鍵一起燒掉，所以這個意圖之後不可能再被結算 ——
     *      代理重送一模一樣的東西也不會重新排隊。這是刻意的取捨：
     *      家人改變心意要付的話，得產生一筆新的意圖（金額或任務不同 → 不同的鍵），
     *      而不是讓「再送一次」有機會過關。
     */
    function reject(uint256 proposalId, string calldata reason) external onlyGuardian {
        require(proposalId < proposals.length, "no such proposal");
        Proposal storage p = proposals[proposalId];
        require(p.status == Status.Pending, "proposal is not pending");

        p.status = Status.Rejected;
        usedIntent[p.memoHash] = true;

        emit PaymentRejected(proposalId, msg.sender, reason);
    }

    // ─── 管理：守護者專用 ────────────────────────────────────────────────

    function setPolicy(uint256 perTxCap, uint256 dailyCap, uint256 approvalThreshold)
        external
        onlyGuardian
    {
        require(approvalThreshold <= perTxCap, "approvalThreshold exceeds perTxCap");
        policy = Policy(perTxCap, dailyCap, approvalThreshold);
        emit PolicyUpdated(perTxCap, dailyCap, approvalThreshold);
    }

    function setAllowlist(address payee, bool allowed) external onlyGuardian {
        allowlist[payee] = allowed;
        emit AllowlistUpdated(payee, allowed);
    }

    /// @notice 撤換門神的付款金鑰。金鑰外洩時家人的第一個動作。
    function rotateOperator(address newOperator) external onlyGuardian {
        require(newOperator != address(0), "operator is zero address");
        address previous = operator;
        operator = newOperator;
        emit OperatorRotated(previous, newOperator);
    }

    // ─── 查詢 ────────────────────────────────────────────────────────────

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    /// @notice 今天還剩多少額度。UI 直接顯示這個數字給守護者看。
    function remainingToday() external view returns (uint256) {
        uint256 spent = spentByDay[dayIndex(block.timestamp)];
        return spent >= policy.dailyCap ? 0 : policy.dailyCap - spent;
    }
}
