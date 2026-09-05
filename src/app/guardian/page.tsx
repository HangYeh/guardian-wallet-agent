import { AllowlistToggle, ApprovalButtons, PolicyForm } from '@/components/GuardianControls';
import GuardianLive from '@/components/GuardianLive';
import { loadDemo, formatTWD, payeeById } from '@/lib/demo';
import { blockedAttempts } from '@/lib/report';
import { cooldownRemainingHours } from '@/lib/policy';
import { allowlistedAt, effectivePolicy, state } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * 從稽核事件裡撈出這筆付款當初的政策判定。
 * 稽核鏈本來就記著理由，畫面直接用它，不另外存一份 —— 兩份會走鐘。
 */
function decisionOf(paymentId: string): { summary: string; rulesHit: string[] } | undefined {
  const e = state()
    .audit
    .filter((x) => x.type === 'policy.decided' && x.paymentId === paymentId)
    .at(-1);
  if (!e) return undefined;
  const hits = e.details.rulesHit;
  return { summary: e.summary, rulesHit: Array.isArray(hits) ? (hits as string[]) : [] };
}

/** 台北時間的時：分。稽核事件存的是 UTC。 */
function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function GuardianPage() {
  const demo = loadDemo();
  const { persona } = demo;
  // 讀「現在生效的」政策，不是劇本檔裡的原始值 —— 守護者改過就要看得到。
  const policy = effectivePolicy();
  const now = new Date();
  const pending = state().payments.filter((p) => p.status === 'pending_approval');
  // 家人通知只列最近五則；再多就沒人看了。
  const alerts = blockedAttempts(state()).slice(0, 5);

  const rules: { label: string; value: string; note: string }[] = [
    { label: '單筆上限', value: formatTWD(policy.perTxCap), note: '超過就直接拒付，合約層強制' },
    { label: '單日上限', value: formatTWD(policy.dailyCap), note: '擋分批小額掏空' },
    { label: '核准門檻', value: formatTWD(policy.approvalThreshold), note: `超過要${persona.guardian.name}點頭` },
    {
      label: '新收款人',
      value: policy.newPayeeRequiresApproval ? '一律要核准' : '免核准',
      note: policy.newPayeeRequiresApproval
        ? `剛加進白名單的，${policy.newPayeeCooldownHours} 小時內仍要核准`
        : '加進白名單就能自動付',
    },
    {
      label: '安靜時段',
      value: policy.quietHours ? `${policy.quietHours[0]}:00 – ${policy.quietHours[1]}:00` : '無',
      note: '深夜不自動付款，隔天早上再處理',
    },
  ];

  return (
    <main className="page">
      <h1 className="page-title">守護者</h1>
      <p className="page-sub">
        {persona.guardian.name}（{persona.elder.name}的{persona.guardian.relation}）在這裡設定規則、核准例外。
        規則不是寫在程式裡，是寫進鏈上合約，所以就算門神被騙，超出規則的錢也出不去。
      </p>

      {/**
       * 給家人的通知：門神擋下了什麼。
       *
       * 攔截那一刻阿嬤看得到，但**家人不在場**。這幾張卡片是整個作品裡唯一
       * 主動告訴家人「你媽剛剛被詐騙集團找上了」的地方 —— 防詐系統擋掉一筆
       * 卻沒人知道，跟沒擋一樣，因為下一通電話還是會打來。
       *
       * 事實從 `report.ts` 的 `blockedAttempts()` 來，跟週報頭條**共用同一份**：
       * 哪些事件算「有人來騙」（要濾掉紅隊按鈕）、金額該記對方開口要的還是信封封的，
       * 兩邊的答案必須永遠一致。各寫一份的話，遲早一邊改了另一邊沒跟上，
       * 而那時畫面上的兩個數字會同時看起來都很合理。
       */}
      {alerts.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="text-[1.05rem] font-bold">門神的通知</h2>
            <span className="pill" style={{ color: 'var(--color-cinnabar)' }}>
              {alerts.length} 則
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {alerts.map((a) => (
              <div
                key={a.id}
                className="card p-5"
                style={{
                  borderLeft: '6px solid var(--color-cinnabar)',
                  background: 'var(--color-cinnabar-bg)',
                }}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-[1.15rem] font-bold">
                    有人向{persona.elder.name}要
                    {a.requested != null && (
                      <>
                        {' '}
                        <b className="mono">{a.requested.toLocaleString('zh-TW')}</b> 元
                      </>
                    )}
                    ，門神擋下來了
                    {a.payee && <>。收款方是「{a.payee}」</>}
                  </span>
                  <span className="mono text-[0.75rem] text-[var(--color-ink-2)]">{hhmm(a.at)}</span>
                </div>
                <p className="mt-1.5 max-w-[60ch] text-[0.9rem] leading-relaxed">{a.summary}</p>
                {a.rulesHit.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {a.rulesHit.map((r) => (
                      <span key={r} className="pill mono text-[0.7rem]">
                        {r}
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[0.78rem] text-[var(--color-ink-2)]">
                  錢沒有出去，不必做任何事。建議打個電話給{persona.elder.name}，
                  同一批人通常會再打第二通。
                  {a.capped != null && a.requested != null && a.capped < a.requested && (
                    <>
                      {' '}
                      （就算門神當時判錯，授權信封也只封了{' '}
                      <span className="mono">{a.capped.toLocaleString('zh-TW')}</span> 元，
                      最多只會付出這個數。）
                    </>
                  )}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-[1.05rem] font-bold">等你核准</h2>
        <GuardianLive />
      </div>
      {pending.length === 0 ? (
        <div className="card p-5 text-[0.88rem] text-[var(--color-ink-2)]">
          目前沒有待核准項目。幕三的孫子紅包會出現在這裡，因為收款人不在白名單。
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {pending.map((p) => {
            const decided = decisionOf(p.id);
            const hasAddress = !/^0x0{40}$/i.test(p.payee.address);
            return (
              <div key={p.id} className="card border-l-4 border-l-[var(--color-ochre)] p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-[1.25rem] font-bold">{p.payee.name}</span>
                  <span className="mono text-[1.5rem] font-bold">
                    {p.amount.toLocaleString('zh-TW')}
                    <span className="ml-1 text-[0.9rem] font-normal text-[var(--color-ink-2)]">元</span>
                  </span>
                </div>

                {decided && (
                  <p className="mt-2 max-w-[60ch] text-[0.9rem] leading-relaxed">
                    {decided.summary.replace(/^政策判定 w+：/, '')}
                  </p>
                )}

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(decided?.rulesHit ?? []).map((r) => (
                    <span key={r} className="pill mono text-[0.7rem]">{r}</span>
                  ))}
                </div>

                <p className="mono mt-2 text-[0.72rem] text-[var(--color-ink-3)]">
                  收款地址 {p.payee.address}
                </p>

                <div className="mt-3">
                  <ApprovalButtons
                    paymentId={p.id}
                    payeeName={p.payee.name}
                    amount={p.amount}
                    hasAddress={hasAddress}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">支出政策</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rules.map((r) => (
          <div key={r.label} className="card p-4">
            <div className="label">{r.label}</div>
            <div className="mono mt-1 text-xl font-bold">{r.value}</div>
            <div className="mt-1 text-[0.8rem] text-[var(--color-ink-2)]">{r.note}</div>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <PolicyForm
          perTxCap={policy.perTxCap}
          dailyCap={policy.dailyCap}
          approvalThreshold={policy.approvalThreshold}
          quietHours={policy.quietHours}
        />
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">收款人</h2>
      <p className="page-sub">
        白名單上的收款人才可能被自動付款。其餘的一律要{persona.guardian.name}核准，
        合約端也擋著同一條規則。
      </p>

      <div className="scroll-x card">
        <table className="grid">
          <thead>
            <tr>
              <th>名稱</th><th>類別</th><th className="num">常見金額</th><th>狀態</th><th>動作</th><th>鏈上地址</th>
            </tr>
          </thead>
          <tbody>
            {demo.payees.map((p) => {
              const on = policy.allowlist.includes(p.id);
              // 剛加進白名單的人還在冷卻期：跟政策引擎用同一個算法，畫面不會比引擎樂觀。
              const coolingLeft = on ? cooldownRemainingHours(policy, allowlistedAt(p.id), now) : 0;
              return (
                <tr key={p.id}>
                  <td className="font-medium">{p.name}</td>
                  <td className="text-[var(--color-ink-2)]">{p.kind}</td>
                  <td className="num">{p.typicalAmount ? p.typicalAmount.toLocaleString('zh-TW') : '—'}</td>
                  <td>
                    {coolingLeft > 0 ? (
                      <span
                        className="pill"
                        style={{ color: 'var(--color-ochre)' }}
                        title="剛加進白名單。冷卻期內的付款仍要你核准，過了才會在額度內自動付"
                      >
                        冷卻中 · 還剩 {Math.ceil(coolingLeft)} 小時
                      </span>
                    ) : (
                      <span className="pill" style={{ color: on ? 'var(--color-celadon)' : 'var(--color-ink-3)' }}>
                        {on ? '白名單' : '需核准'}
                      </span>
                    )}
                  </td>
                  <td>
                    <AllowlistToggle
                      payeeId={p.id}
                      payeeName={p.name}
                      allowed={on}
                      cooldownHours={policy.newPayeeRequiresApproval ? policy.newPayeeCooldownHours : 0}
                    />
                  </td>
                  <td className="mono text-[0.72rem] text-[var(--color-ink-3)]">{p.address}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">已知的高風險帳戶</h2>
      <div className="scroll-x card">
        <table className="grid">
          <thead><tr><th>帳號</th><th>來源</th><th>說明</th></tr></thead>
          <tbody>
            {demo.blocklist.map((b) => (
              <tr key={b.account}>
                <td className="mono text-[var(--color-cinnabar)]">{b.account}</td>
                <td className="mono">{b.source}</td>
                <td className="text-[var(--color-ink-2)]">{b.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="todo mt-6">
        核准、拒絕、改政策、調白名單都走 server action ——
        <b>`GUARDIAN_TOKEN` 從頭到尾沒進過瀏覽器</b>，因為只要塞進頁面讓前端帶，
        任何能開這一頁的人就都拿到它了。
        <br />
        誠實的限制：這一頁本身沒有登入。現在靠的是 <span className="mono">npm run dev</span>{' '}
        預設只綁 localhost；真實產品要的是家人裝置上的 passkey 簽章，那在路線圖裡。
        政策改動目前只在鏈下生效，寫進合約的 <span className="mono">setPolicy</span> 還沒接。
        {payeeById(demo, 'contact_xiaoyu') && ' 幕三會用到的孫子帳戶已經在收款人清單裡，但刻意不放白名單。'}
      </div>
    </main>
  );
}
