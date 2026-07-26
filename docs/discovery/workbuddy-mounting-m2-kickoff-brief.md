# Kickoff Context Brief — M2 WorkBuddy 挂载与真实 Edge

> 状态：已授权开工
>
> 日期：2026-07-25
>
> 继承：`salted-fish-king-control-plane-kickoff-brief.md` 的已确认边界

## 1. Starting point

- M1 已有只读公开办公室、SSE、Presence/Lease、今日排行和 Daily Award。
- 当前页面没有管理写接口；`public_view_token` 只能读取，不能授权挂载。
- 数据库已有 Account、Office、Logical Agent、Agent Instance、Device
  Credential 和 Mount 主体，但没有登录、邀请兑换和设备 enrollment。
- WorkBuddy 本地已经能产出拆分后的 `display_state`、`activity_state` 与
  `idle_stage`，Tauri 仍只消费 legacy 状态字符串。
- Edge 上报协议已有 sequencing/fencing，但真实签名输入与 Ed25519 verifier
  尚未完成。

## 2. Four-bucket map

### Known knowns

- Guest 观看保持零登录，写入能力不能来自公开分享 token。
- 浏览器 Account session、设备 credential、Agent Mail OAuth 必须彼此分离。
- 设备私钥只存在 OS credential store；JS、数据库和日志均不可接触。
- Edge 只上传派生状态和官方 `pet_id`，绝不上传 WorkBuddy/邮件正文。
- 本地桌宠在 Control Plane 断网时必须继续工作。

### Known unknowns

- 正式事务邮件 provider、sender domain 与 secret 尚未提供。
- Agent Mail 官方没有公开第三方 Web SSO/OIDC 或可验证 identity assertion。
- Windows WorkBuddy、Credential Manager 与安装链路尚未完成真实 E2E。

### Unknown knowns

- 首次配对是否需要 deep link，需在安装包签名与真实 macOS bundle 中验证；
  首版可用人工输入短码，不让 deep link 阻塞。
- 管理页最终视觉可在真实配对闭环完成后再收敛。

### Unknown unknowns

- 丢 ACK、重启、换设备和长离线组合下的 outbox 边界。
- 开源客户端伪造活动、公开别名滥用和邀请链接泄漏。

## 3. Blindspot / prior-art findings

- 当前 validator 对包含 `signature` 的完整 envelope 做 canonicalization，签名会
  自引用。M2 必须冻结 domain-separated、移除 `signature` 后的 canonical
  signing bytes，并用 Rust/TypeScript golden vector 锁定。
- 生产启动路径当前始终使用 `DisabledEdgeVerifier`；只有开发 fake edge 可写。
- 当前 Tauri 使用 legacy `watch::run`，必须切到 `run_snapshots`；客户端不可
  上传 `idle_stage` 参与计分。
- 宠物选择只在 WebView `localStorage`，需要显式同步官方 `pet_id` 给 Rust。
- 现有 loopback approval 服务 CORS 为 `*`，不能承载 pairing 或设备秘密。
- Agent Mail `agently-cli +me` 只能发现邮箱，不能向服务端证明邮箱控制权；
  CLI access/refresh token 不能上传。

## 4. Open questions ranked by leverage

1. 事务邮件 provider 与 sender domain：阻塞真实 Agent Mail/普通邮箱挑战。
2. 正式域名：影响 cookie、magic link、deep link 与 CSP。
3. Windows 测试机和签名证书：阻塞 Windows 正式支持。

以上输入不阻塞真实设备签名、一次性 pairing 和公开办公室按钮。

## 5. Proposed direction and decisions

本轮交付一个可独立验收的 M2A：

1. 冻结签名输入，启用数据库 Ed25519 verifier。
2. 增加短期、单次使用、哈希存储的 pairing session。
3. 浏览器创建自己的 unlisted Office，选择 alias、官方宠物和三项 consent，
   得到一次性配对码；创建者的首个设备成为该 Account/Agent 的 credential。
4. WorkBuddy 托盘增加“挂载到办公室”，本地生成 Ed25519 key，私钥写 OS
   credential store，兑换配对码后开始状态变化与 heartbeat 上报。
5. 公开办公室增加明确 CTA；完成配对后跳转到新 Office，看见自己的宠物。
6. 邀请他人加入、Owner 管理和邮箱恢复作为 M2B，复用同一 enrollment，不让
   M2A 的临时设备会话冒充已验证邮箱身份。

Agent Mail 决策：

- 本轮只保留 `LoginIdentity`/mail challenge adapter 边界。
- 在事务邮件 provider 未配置前，生产邮箱认证 fail closed。
- 不将 `+me` 输出当服务端凭证，不上传 OAuth token，不后台监听邮箱。
- UI 明确标注“设备配对预览”，不得标注为“Agent Mail 登录成功”。

## 6. Success criteria

- 错误 key、篡改字段、坏 Base64、撤销 key 和 replay 均被拒绝。
- Rust/TypeScript signing golden vector 完全一致。
- pairing code 高熵、短期、单次使用、哈希落库；并发兑换只能成功一次。
- `public_view_token` 无法调用任何写接口。
- 配对完成后新 Agent 出现在自己的 `/o/:token`，真实 WorkBuddy 状态通过 SSE
  更新，断网不影响本地桌宠。
- 私钥不落明文文件、不进入 JS/日志/数据库；切换 Control Plane origin 必须
  重新 enrollment。
- 页面在桌面、9:16 和 3:4 viewport 下 CTA 可见且不遮挡办公室主体。

## 7. Remaining risks / inputs

- 没有事务邮件 provider 前不宣称 Agent Mail 登录完成。
- 没有 macOS/Windows 真实安装 E2E 前不宣称跨平台生产可用。
- M2A 的 Account 恢复依赖仍在本机的设备 credential；M2B 邮箱验证完成前 UI
  必须提示这一限制。
- 当前 `core/watch/frontend` 有用户未提交的宠物与状态改动；M2 只做小块追加，
  不覆盖或混入这些改动的提交。
