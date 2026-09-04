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
 * 每一筆付款都綁一個 memoHash，就是鏈下 PaymentIntent 的冪等鍵
 * keccak256("taskId|merchant|amount|assetNetwork")。
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

    /// @notice 每日已花金額，鍵是 block.timestamp / 1 days。
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
    function pay(address payee, uint256 amount, bytes32 memoHash, uint256 expiresAt)
        external
        onlyOperator
    {
        require(block.timestamp <= expiresAt, "PolicyViolation: intent expired");
        require(!usedIntent[memoHash], "Replay: intent already settled");
        require(allowlist[payee], "PolicyViolation: payee not allowlisted");
        require(amount <= policy.perTxCap, "PolicyViolation: per-tx cap exceeded");
        require(amount <= policy.approvalThreshold, "PolicyViolation: guardian approval required");

        uint256 day = block.timestamp / 1 days;
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
        uint256 expiresAt,
        string calldata reason
    ) external onlyOperator returns (uint256 proposalId) {
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

        uint256 day = block.timestamp / 1 days;
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
        uint256 spent = spentByDay[block.timestamp / 1 days];
        return spent >= policy.dailyCap ? 0 : policy.dailyCap - spent;
    }
}
