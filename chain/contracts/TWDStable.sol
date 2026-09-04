// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TWDStable
 * @notice Demo 用的測試代幣，模擬新台幣計價的穩定幣或代幣化存款。
 *
 * 小數位設為 0，因為新台幣日常金額不用小數，帳單上的 1280 在鏈上就是 1280。
 * 這讓 demo 畫面的數字跟合約事件裡的數字完全一致，評審不用心算換算。
 *
 * 真實落地時這一層會換成銀行的代幣化存款或受監管穩定幣，
 * GuardedWallet 的政策語意完全不需要改動。
 */
contract TWDStable is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Test TWD", "tTWD") Ownable(initialOwner) {}

    /// @dev 新台幣不用小數位。
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /// @notice 鑄幣給 demo 錢包。只有部署者能呼叫。
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
