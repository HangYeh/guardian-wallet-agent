import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { network } from 'hardhat';

/**
 * 部署 TWDStable + GuardedWallet，並把政策與白名單從劇本資料灌進去。
 *
 * 本地：  npm run chain:deploy
 * 測試網：npm run chain:deploy:testnet
 *
 * 政策與收款人名單都讀 `demo-data/guardian-demo.json`，不在這裡重寫一份 ——
 * 鏈上與畫面的規則必須來自同一個地方，否則 demo 到一半兩邊會對不起來，
 * 而那種不一致在舞台上看起來就像 bug。
 *
 * 輸出寫進 `chain/deployments/<network>.json`，錢包頁與 viem adapter 讀它。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, '..', '..', 'demo-data', 'guardian-demo.json');
const OUT_DIR = join(HERE, '..', 'deployments');

type DemoPayee = {
  id: string;
  name: string;
  address: `0x${string}`;
  allowlisted: boolean;
  accountIndex?: number;
};

type Demo = {
  policy: {
    perTxCap: number;
    dailyCap: number;
    approvalThreshold: number;
  };
  payees: DemoPayee[];
};

const demo = JSON.parse(readFileSync(DEMO, 'utf8')) as Demo;

/** 錢包一開始有多少 tTWD。夠演完四幕還剩很多，數字好記。 */
const INITIAL_BALANCE = 100_000n;

const { viem, networkName } = await network.getOrCreate();

const publicClient = await viem.getPublicClient();
const wallets = await viem.getWalletClients();

const guardian = wallets[0];
// 測試網只會有兩把金鑰（guardian、operator）；本地鏈有 20 把。
const operator = wallets[1] ?? wallets[0];

const chainId = await publicClient.getChainId();

console.log(`\n網路 ${networkName}（chainId ${chainId}）`);
console.log(`guardian ${guardian.account.address}`);
console.log(`operator ${operator.account.address}`);
if (operator.account.address === guardian.account.address) {
  console.warn('⚠ 只有一把金鑰，guardian 與 operator 是同一個地址 —— 這在測試網上不該發生。');
}

// ── 部署 ────────────────────────────────────────────────────────────────

const token = await viem.deployContract('TWDStable', [guardian.account.address], {
  client: { wallet: guardian },
});
console.log(`\nTWDStable      ${token.address}`);

const policy = {
  perTxCap: BigInt(demo.policy.perTxCap),
  dailyCap: BigInt(demo.policy.dailyCap),
  approvalThreshold: BigInt(demo.policy.approvalThreshold),
};

const wallet = await viem.deployContract(
  'GuardedWallet',
  [guardian.account.address, operator.account.address, token.address, policy],
  { client: { wallet: guardian } },
);
console.log(`GuardedWallet  ${wallet.address}`);

// ── 灌資料 ──────────────────────────────────────────────────────────────

await token.write.mint([wallet.address, INITIAL_BALANCE], { account: guardian.account });

const allowlisted = demo.payees.filter((p) => p.allowlisted);
for (const p of allowlisted) {
  await wallet.write.setAllowlist([p.address, true], { account: guardian.account });
}

// Hardhat 產生的合約型別放在 chain/types（不進版控），所以這裡明講回傳型別
// —— 讓別人 clone 下來還沒 compile 也能通過 typecheck。
const balance = (await wallet.read.balance()) as bigint;
console.log(`\n餘額           ${balance.toLocaleString('en-US')} tTWD`);
console.log(`白名單         ${allowlisted.length} 個收款人`);
for (const p of allowlisted) {
  console.log(`  ${p.address}  ${p.name}`);
}

// ── 落地 ────────────────────────────────────────────────────────────────

const record = {
  network: networkName,
  chainId,
  deployedAt: new Date().toISOString(),
  guardian: guardian.account.address,
  operator: operator.account.address,
  token: token.address,
  wallet: wallet.address,
  initialBalance: Number(INITIAL_BALANCE),
  policy: demo.policy,
  allowlist: allowlisted.map((p) => ({ id: p.id, name: p.name, address: p.address })),
};

mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, `${networkName}.json`);
writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

console.log(`\n寫入 chain/deployments/${networkName}.json`);
console.log('\n把這兩行貼進根目錄的 .env：');
console.log(`TOKEN_ADDRESS=${token.address}`);
console.log(`WALLET_ADDRESS=${wallet.address}\n`);
