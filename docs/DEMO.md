# 門神錢包 五分鐘試玩指南

給評審與第一次打開這個 repo 的人：裝好之後按哪裡、應該看到什麼、看到不一樣的東西怎麼辦。
安裝細節在 [README 的安裝與執行](../README.md#安裝與執行)，設計原理在 [系統架構](../README.md#系統架構)。

## 一、一分鐘起來（不需要任何金鑰）

```bash
git clone https://github.com/HangYeh/guardian-wallet-agent.git
cd guardian-wallet-agent
npm install
cp .env.example .env
```

把 `.env` 裡的 `DEMO_MODE=live` 改成 `DEMO_MODE=fixtures`，然後：

```bash
npm run dev
# 開 http://127.0.0.1:3000
```

fixtures 模式播放錄好的模型回應，模型標籤會寫「gpt-4.1-mini（錄音回放）」，延遲個位數毫秒；
`CHAIN_MODE=mock` 用記憶體帳本，照抄合約的每一道檢查。四幕與兩則加演可以完整重現，斷網也一樣。

想看真的模型：`.env` 填 `OPENAI_API_KEY`、`DEMO_MODE=live`。畫面、判決、數字都一樣，只是模型真的在讀。

## 二、五個頁面

| 網址 | 給誰看 | 看什麼 |
|---|---|---|
| `/` | 阿嬤 | 三顆大鍵、門神的判決卡、這個月的狀況 |
| `/agent` | 評審 | 門神管線每一步的即時軌跡（SSE） |
| `/guardian` | 家人 | 待核准清單、支出政策、白名單、門神的通知 |
| `/wallet` | 評審 | 合約狀態、合約強制的檢查、紅隊按鈕、交易紀錄 |
| `/audit` | 家人與評審 | 雜湊鏈稽核、週報「本月守住多少」、四條異常偵測 |

每一頁底部都有 demo bar：四幕、兩則加演、紅隊入口、一鍵重置。從任何一頁按都會跳到該演的頁面自動開演。

## 三、照劇本按

建議順序就是評選影片的順序。左邊開 `/`，右邊開 `/agent` 並排看最好。

| 按 | 應該看到 |
|---|---|
| **幕一 電費** | 綠卡「門神幫妳繳好了」。門神讀到台灣電力公司、1,280 元；下面「封好的授權信封」是終端機樣式的六個欄位，那是政策引擎封的，模型碰不到。`/agent` 會長出一張「收到一張帳單照片」的卡，看到 → 判斷 → 動手 → 覆核，最後一行有交易雜湊 |
| **幕二 詐騙** | 朱紅卡「這是詐騙，門神沒有付」，大字「這個帳號被通報過是詐騙帳戶」。往下捲「詐騙的話術（5 項）」：黑名單帳號、偽裝成系統指令、冒充健保機關、要求立刻行動、要求保密。這五項是規則抓的，不靠模型，數字穩定。`/guardian` 最上面「門神的通知」寫的是對方開口要的 50,000，不是信封封的 3,000 |
| **幕三 紅包** | 橘卡「這筆要等家人點頭」，大字「門神看不出詐騙的跡象」，話術 0 項。這不是懷疑孫子，是規矩：新收款人、超過核准門檻。到 `/guardian` 按「核准」→「確定」，清單回到「目前沒有待核准項目」，`/wallet` 交易紀錄多一筆 |
| **幕四 週報** | `/audit` 的「本月守住 NT$51,687」＝ 攔下的 50,000 ＋ 退回的重複扣款 599 ＋ 停掉的殭屍訂閱 1,088。調價 1,600 只提醒不加總。這個數字是從稽核鏈算出來的，多演一則加演它會跟著變 |
| **加演 假投資、假孫子** | 都攔下；週報的攔截總額跟著變成 85,000 |

**兩件事看起來像壞掉，其實是政策在做事：**

- **深夜（22:00–7:00）幕一會變成「這筆要等家人點頭」**，理由寫著安靜時段。demo 預設政策有安靜時段。要看綠卡：`/guardian` 最下面「支出政策」把「安靜時段」清空 → 按「更新政策」。每按一次「一鍵重置」都要重做。
- **同一幕連按兩次，第二次說「這一筆先前已經付過了，我沒有再付一次」**。這是防重放：冪等鍵只認一次。要重演就按「一鍵重置」。

## 四、想看合約真的擋：紅隊按鈕

`.env` 設 `ENABLE_REDTEAM=true`，並在 `GUARDIAN_TOKEN` 填一串隨機字串（守護者頁與紅隊按鈕都靠它），重新整理 `/wallet`。

五顆按鈕**跳過整條政策管線**，直接拿 operator 的鑰匙去打合約。等於假設門神已經被完全攻破。每一顆都會回「合約擋下來了」，並印出合約的原話：

| 按鈕 | 合約回的原話 |
|---|---|
| 付給陌生帳戶 | `PolicyViolation: payee not allowlisted` |
| 超過單筆上限 | `PolicyViolation: per-tx cap exceeded` |
| 重放已付的款 | `Replay: intent already settled` |
| 用過期的授權 | `PolicyViolation: intent expired` |
| 在紀錄上寫成另一筆 | `IntentMismatch: memo does not describe this payment` |

mock 模式也會演（記憶體帳本照抄合約的檢查）；要看真的 revert 走下一節。

## 五、想看真的鏈：本地 Hardhat

```bash
cd chain && npm install && cd ..
npm run chain:node          # 終端機 1：Hardhat 節點，port 8645
npm run chain:deploy        # 終端機 2：部署 tTWD + GuardedWallet，灌政策與白名單
```

`.env` 改 `CHAIN_MODE=local`，重新整理。`/wallet` 會顯示合約地址與交易雜湊，幕三的提案與核准真的在鏈上走（`propose` → `approve`）。

**重演前先重新部署**：鏈上付過的就是付過的，「一鍵重置」只清伺服器，不重置鏈。要從頭再演，`npm run chain:deploy` 一次再按一鍵重置。

Base Sepolia 上已部署的合約與一筆真的結算，地址在 [README 鏈上設計](../README.md#鏈上設計)。

## 六、想自己驗證

```bash
npm test                # vitest：384 條，含 pipeline.test.ts 把網路封死整跑六幕 + 核准 + 週報 + 重置重跑
npm run chain:test      # Hardhat：21 條合約測試
npm run scan:secrets    # 掃工作目錄與 git 全歷史有沒有金鑰
```

- **稽核鏈的竄改偵測**：用編輯器打開 `data/audit.jsonl`，隨便改一筆裡的一個數字，重新整理 `/audit`，頁面會指出鏈接斷在第幾筆。改完按一鍵重置就乾淨了。
- **memoHash 可自己驗**：合約的 `intentHash()` 是 `public pure`，拿稽核檔裡的 taskId、收款地址、金額、assetNetwork 就能算一次，跟鏈上 `PaymentExecuted` 事件比對。

## 七、看到這些怎麼辦

| 症狀 | 原因與處理 |
|---|---|
| 幕一變成「這筆要等家人點頭」 | 深夜安靜時段。見第三節，清空安靜時段再更新政策 |
| 「先前已經付過了」 | 防重放，正確行為。一鍵重置；local 模式先 `npm run chain:deploy` |
| fixtures 模式說「找不到錄音」 | 錄音的鍵含請求內容，`ENABLE_VISION=true`（預設）要維持 |
| 紅隊區寫「沒有開啟」 | `.env` 的 `ENABLE_REDTEAM` 不是 true |
| 守護者 API 回 503 | `GUARDIAN_TOKEN` 沒設。不設定不等於不設防，API 一律拒絕；頁面按鈕仍可用 |
| dev server 跑很久之後某一頁 500，錯誤寫 `Jest worker` | Next dev 的編譯 worker 掛了，不是程式的問題。關掉重開 `npm run dev` |
| Hardhat 節點起不來 | 本專案用 8645 埠，因為 Windows 把 8499–8598 保留給 Hyper-V。8645 也被佔就改 `chain/hardhat.config.ts` 與 `.env` 的 `LOCAL_RPC_URL` |

## 八、影片裡的每一幕都能在這裡重現

評選影片的畫面就是第三節的順序，沒有任何一幕是後製的。影片裡的鏈是本機 Hardhat；合約另已部署 Base Sepolia。
