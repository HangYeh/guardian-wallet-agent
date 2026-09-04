import { fileURLToPath } from 'node:url';
import type { HardhatUserConfig } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';

// 金鑰放在儲存庫根目錄的 .env，永遠不進版控。沒有 .env 也要能編譯與跑本地鏈。
// 用 fileURLToPath 而不是 URL.pathname，後者在含非 ASCII 字元的路徑下會是百分號編碼。
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  // 沒有 .env 就用預設值，只有部署到測試網才真的需要金鑰。
}

/** Hardhat 本地鏈的標準助記詞。demo 收款人地址就是從這裡衍生的帳戶 #5–#13。 */
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

function testnetAccounts(): string[] {
  return [process.env.GUARDIAN_PRIVATE_KEY, process.env.OPERATOR_PRIVATE_KEY].filter(
    (k): k is string => typeof k === 'string' && /^0x[0-9a-fA-F]{64}$/.test(k),
  );
}

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem],

  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },

  networks: {
    // 單元測試用的模擬鏈
    hardhat: {
      type: 'edr-simulated',
      chainType: 'l1',
      accounts: { mnemonic: HARDHAT_MNEMONIC, count: 20 },
    },

    // `npm run chain:node` 起的常駐節點，舞台 demo 走這條，不吃現場網路。
    //
    // 連接埠不是 Hardhat 預設的 8545：這台 Windows 把 8499–8598 整段保留給 Hyper-V，
    // 綁上去會拿到 EACCES。換到 8645，用 netsh 確認過不在任何排除範圍內。
    localhost: {
      type: 'http',
      url: process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8645',
      accounts: { mnemonic: HARDHAT_MNEMONIC, count: 20 },
    },

    // 公開測試網。演講示範用 Base，這裡用它的測試網最貼近評審環境。
    baseSepolia: {
      type: 'http',
      chainType: 'op',
      url: process.env.RPC_URL ?? 'https://sepolia.base.org',
      chainId: 84532,
      accounts: testnetAccounts(),
    },
  },
};

export default config;
