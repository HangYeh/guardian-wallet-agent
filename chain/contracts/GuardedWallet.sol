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
 * keccak256("taskId|merchant|amount|expiresAt")。同一把鍵只能結算一次，
 * 所以逾時重試不會變成第二次付款。
 *
 * @dev M0.4 骨架：狀態、事件、管理函式已完成並可編譯。
 *      pay / propose / approve / reject 的內容在 M3.1 實作，M3.2 補十條測試。
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

    /// @notice 已結算的意圖。防重放與冪等都靠這一個對照表。
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

    // ─── 付款：M3.1 實作 ─────────────────────────────────────────────────

    /**
     * @notice 門神在政策範圍內直接付款。
     * @dev M3.1 要依序檢查：防重放、白名單、單筆上限、核准門檻、單日上限。
     *      回退訊息就是畫面上顯示給評審看的字串，不要改。
     */
    function pay(address payee, uint256 amount, bytes32 memoHash) external onlyOperator {
        revert("NotImplemented: pay lands in M3.1");
    }

    /// @notice 超出政策的付款改走提案，等守護者決定。
    function propose(address payee, uint256 amount, bytes32 memoHash, string calldata reason)
        external
        onlyOperator
        returns (uint256 proposalId)
    {
        revert("NotImplemented: propose lands in M3.1");
    }

    /// @notice 守護者核准提案並立即結算。
    function approve(uint256 proposalId) external onlyGuardian {
        revert("NotImplemented: approve lands in M3.1");
    }

    /// @notice 守護者拒絕提案。被拒絕的意圖不會再被結算。
    function reject(uint256 proposalId, string calldata reason) external onlyGuardian {
        revert("NotImplemented: reject lands in M3.1");
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
