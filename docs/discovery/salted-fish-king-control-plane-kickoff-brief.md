# Kickoff Context Brief — “咸鱼王”多人办公室与未来 Agent Team Control Plane

> 状态：已确认（包含宣发渠道补充）
>
> 首次确认：2026-07-24
>
> 范围：产品发现、技术边界和实施前验收标准；本文不代表已经开始业务实现。

## 1. Starting point

### 用户已经明确的目标

- 第一优先级是通过有趣、易分享的桌宠体验获取自媒体流量；企业实用性和治理能力随后演进。
- 将单机 WorkBuddy 桌宠扩展为多人“办公室”场景，实时展示多个 WorkBuddy 的派生状态。
- 以办公室本地日为统计单位，选出当日有效摸鱼时长最长的 Agent，生成“咸鱼王”。
- 保留现有四级摸鱼形态：
  - 连续空闲满 15 分钟：摸新鲜鱼；
  - 满 25 分钟：摸咸鱼；
  - 满 35 分钟：穿咸鱼服；
  - 满 60 分钟：统一变成同一条咸鱼。
- 产品先是趣味、只读、可传播的 presence 层；未来再衍生 Agent Team Control Plane。
- 项目开源，以 GitHub 为源码真相，同时运行一个官方 Railway 实例；用户无需自备传统服务器，也可以完整自托管。
- Agent Mail 是默认登录/验证身份入口，但普通邮箱 magic link 是恢复和降级通道。
- 宣发渠道以 `9:16` 短视频为主，包括抖音、视频号和小红书；同时覆盖公众号文章与小红书 `3:4` 图文。

### 当前代码库事实

- 仓库是 Rust workspace：`core`、`watch`、`hookd`、`bridge`、Tauri 桌面端。
- 当前状态链为：

  ```text
  WorkBuddy Hooks
    -> hooks/project.py 隐私投影
    -> ~/.workbuddy-buddy/events.spool
    -> wb-buddy-watch
    -> wb-buddy-core::Machine
    -> Tauri 事件或 loopback /state
    -> 单宠物 Canvas
  ```

- `hooks/project.py` 已在落盘前删除 prompt、tool arguments、消息正文等内容，但本地 spool 仍包含 `session_id`、`tool_name`、`permission_mode` 等结构字段，不能原样上传。
- 当前状态机有五个基础显示态与四个摸鱼显示态；每个 Hook 事件都会刷新 `last_activity_at`，因此信息通知也会错误清零摸鱼计时。
- 当前 `Waiting` 最长保留 24 小时，而摸鱼形态只覆盖 `Idle/Done`；“等待用户回答”和 `idle_prompt` 的显示语义与计分语义冲突。
- watcher 启动时会先广播一次假定 `Idle`，然后才读取 spool；如果直接接云端会制造虚假状态跳变。
- 当前 bridge `/state` 只有明文状态，没有身份、时间、序列或认证。
- 当前本地审批服务器是无认证 loopback HTTP 且 CORS 为 `*`，不得复用为云端认证或 Control Plane 通道。
- 当前界面只有一个 `192 × 208` Canvas 与二列宠物选择器；多人办公室需要独立的多实体 Web 场景。
- 当前安装器只支持 macOS、要求 Git/Python/Rust 并现场编译；CI 只运行 Rust 单测与隐私测试。
- 仓库目前没有 Control Plane、数据库、Docker、Railway 配置或发布工作流。
- 本轮复核时本地 `main` 与 `origin/main` 一致，但工作树已有大量用户宠物资产与代码改动；后续必须精确分批提交，禁止 `git add -A`。

### 已审阅来源

- 本地：
  - `README.md`
  - `Cargo.toml`
  - `hooks/project.py`
  - `hooks/test_privacy.py`
  - `crates/core/src/lib.rs`
  - `crates/watch/src/lib.rs`
  - `crates/bridge/src/main.rs`
  - `src-tauri/src/main.rs`
  - `src-tauri/src/approval.rs`
  - `src-tauri/tauri.conf.json`
  - `frontend/index.html`
  - `frontend/pets/index.json`
  - `install.sh`
  - `.github/workflows/ci.yml`
- 外部参考：
  - [Petdex](https://petdex.dev/)
  - [Awesome Codex Pet](https://codexpet.top/)
  - [CodexPets.net](https://codexpets.net/)
  - [Codex Pets](https://codex-pets.net/)
  - [Agent Mail CLI setup](https://agent.qq.com/doc/cli-setup.md)
  - [Agent Mail help and FAQ](https://help.agent.qq.com/detail/0/1092)
  - [Tauri GitHub release pipeline](https://v2.tauri.app/zh-cn/distribute/pipelines/github/)
  - [Tauri macOS signing and notarization](https://v2.tauri.app/distribute/sign/macos/)

## 2. Four-bucket map

### Known knowns

- 流量优先，首屏必须是可围观、可截图的动态办公室，不是企业仪表盘。
- 一个宠物对应一个稳定的 Logical Agent；Account、Agent、设备实例必须分离。
- 一个 Account 可拥有多个 Logical Agent；一个 Agent 可有独立 Agent Instance。
- 同一 Logical Agent 可通过 Office-scoped Mount 加入多个办公室。
- v1 只读，不提供远程控制、执行、审批或治理命令。
- 官方实例默认公开可访问；办公室默认是不进目录的 unlisted link。
- Guest 零登录观看；只有已验证且受邀成员可挂载宠物。
- 只有完成官方 Edge enrollment 且 Hook 健康检查通过的设备才能完成挂载；开源客户端下不把它宣传为不可伪造的“真实 WorkBuddy 证明”。
- 公开身份只显示 Agent alias；不显示邮箱、真人姓名或 WorkBuddy 内容。
- 统计是趣味数据，不是考勤证据，也不承诺客户端状态不可伪造。
- Control Plane 使用 TypeScript modular monolith + PostgreSQL；Edge 保持 Rust/Tauri。
- v1 使用 REST/JSON/OpenAPI 上报和查询，SSE 推送实时状态。
- GitHub 为源码与 Release 真相；官方 Control Plane 部署到独立 Railway 项目。
- 首发面向中国大陆 WorkBuddy 用户，`zh-CN` 优先、`Asia/Shanghai` 为提议默认；数据模型保留 locale/timezone，Web 保留 `en-US` 扩展框架。
- 分享资产优先级是：`9:16` 动态宣发场景 > `3:4` 图文海报 > 公众号文章配图/辅助横版。

### Known unknowns

- 官方实例使用哪一个事务邮件发送服务与发信域名。
- Apple Developer、macOS Developer ID、公证凭证和 Windows 代码签名证书何时可用。
- Windows 版 WorkBuddy Hooks、安装位置、自动启动和前台唤起的真实行为。
- 官方域名、产品最终中文/英文品牌名、隐私政策与滥用举报入口。
- 办公室默认统计时段的精确起止时间。

### Unknown knowns

- 办公室场景的最终美术主题、空间布局、密度和动效节奏，需要在低保真原型后凭视觉判断收敛。
- 短视频前 3 秒钩子、皇冠/咸鱼揭晓节奏和海报趣味文案，需要通过真实 `9:16`、`3:4` 样稿判断。
- 首批自媒体内容更适合突出“实时围观”“团队入驻”还是“每日咸鱼王”，需要上线后以漏斗数据验证。

### Unknown unknowns

- 中国大陆访问 Railway 的稳定性与分享链路延迟。
- 开源客户端下的排行榜作弊和冒名客户端。
- 公开办公室名称、Agent alias 与分享图的内容滥用。
- 本地时钟漂移、夏令时、断网和设备重装对状态区间的影响。
- 大量动画宠物同时渲染时的移动端性能和内存压力。
- Agent Mail 地址变更、服务波动、同机多 Agent 共用邮箱导致的身份生命周期问题。

## 3. Blindspot and prior-art findings

### 3.1 显示状态不能直接充当计分状态

现有 `Machine` 将 UI 优先级、TTL 和空闲计时耦合在一起。继续沿用会产生以下错误：

- 普通信息通知清零摸鱼计时；
- 等待审批、等待用户回答或失败状态可能被误算；
- watcher 重启制造虚假 `Idle`；
- 状态字符串没有 `state_since`，无法重建可信区间；
- UI 状态优先级改变会意外改变统计结果。

必须拆分：

- `display_state`：驱动宠物当前动作；
- `activity_state`：`unknown/active/eligible_idle/waiting/failed`；`unknown` 表示尚未接受任何 WorkBuddy 信号，绝不能开启 grace；
- `display_since`：显示动作本次切换的时间；
- `activity_since`：活动语义本次切换的时间；服务端用接收时间建立权威边界；
- `idle_stage`：`none/fresh/salted/costume/fish`，由连续有效空闲区间派生，只决定视觉阶段；
- `presence_lease`：判断 Agent Instance 当前是否在线；
- `eligible_idle_interval`：空闲、在线、参赛同意、有效 Mount 与 Office 统计窗口的连续交集。

不能用一个 `state_since` 同时表达显示动作、活动语义和摸鱼阶段；25/35/60 分钟的视觉切换也不能重置连续空闲区间。

### 3.2 “离线”不是客户端事件，而是服务端 Lease 结果

- Edge 只上报状态变化与心跳。
- 服务端根据最后心跳和 TTL 派生在线/离线。
- 心跳丢失后在确定的 `lease_expires_at = last_heartbeat_at + lease_ttl` 时点停止累计，不把之后的离线时间算入排名。
- 心跳不作为无限增长的历史事件表保存；更新实例 Lease/当前快照即可。
- Lease 到期本身也是统计资格边界：服务端必须在该时点关闭/切分有效区间；恢复时即使活动状态未变，也开启新的连续区间并重新计算 15 分钟 grace。
- 迟到 outbox 不回填已经失去 Lease 的计分时间。

### 3.3 Agent Mail 是验证邮箱，不是不可变主键

- 邮箱地址可变，同机多个 Agent 还可能共用一个 Agent Mail 邮箱。
- `alias_id` 没有被官方承诺为永久、跨注销稳定的身份。
- Agent Mail OAuth 不是完整 OIDC；不能把 CLI access/refresh token 上传给 Control Plane。
- Account、Logical Agent 和 Agent Instance 均使用 Control Plane 自己的 UUID。

验证必须拆成三个独立事务：

1. **邮箱控制权验证**
   - 本地 Edge 调用 `agently-cli +me`，只取得地址/alias metadata，不读取或上传 OAuth token。
   - Control Plane 向该地址发送一次性 magic link/OTP。
   - 浏览器完成验证是始终可用的路径；在用户明确点击同意后，Agent Mail Edge 可以执行一次性、精确的邮件搜索并仅提取本系统 challenge token。
   - 不启动后台邮箱监听，不读取其他邮件，不渲染正文，不执行邮件里的提示或链接。
2. **设备 enrollment**
   - Edge 生成设备密钥对，私钥写入 OS keystore。
   - 已验证 Account 显式确认绑定设备公钥；服务端只签发设备身份，不把浏览器 Account session 交给 Edge。
3. **邀请兑换**
   - 可选 `invite_id` 在 Account 与设备均验证后单独兑换；
   - 客户端不能自行声明 Office role。

唯一允许从验证邮件提交的内容是本系统生成、短期、单次使用的 challenge token；这不等于上传任意邮件正文。

普通邮箱 magic link 可以登录和恢复 Account，但在官方 Edge enrollment 与 Hook 健康检查完成前不能挂载宠物。地址变更需要已登录设备或旧身份重新认证，再验证新地址；账号合并只能在同时证明两个身份后显式进行。未来邮件自动化使用独立 `MailboxConnection`，不与 `LoginIdentity`、浏览器 session 或设备凭证共用 token。

### 3.4 轻防作弊边界

v1 能证明“这条上报来自一个已完成官方 Edge enrollment 的设备密钥”，不能证明“用户没有修改开源客户端或伪造本地 WorkBuddy 活动”。产品文案不得使用“已验证真实 WorkBuddy”这一强保证。

MVP 采用：

- 每个 Agent Instance 独立 Ed25519 设备密钥，私钥留在 OS keystore；
- 对 canonical request envelope 签名，并校验 key id、服务端可接受时间窗、boot fencing 与单调序列；
- `instance_id + boot_id + sequence + observed_at` 去重、乱序和重放检查；
- 已撤销设备拒绝上报；
- 一个 Logical Agent 同时只能有一个 active reporting/scoring instance；换设备是显式接管事务，旧实例立即停止影响 Presence 和计分；
- 服务端 `received_at` 是统计边界的权威时间；客户端时间只做有限排序与诊断，不能跳过 grace；
- `idle_stage` 和摸鱼时长由服务端派生，不信任客户端字段参与排名；
- UI 固定标注“趣味统计 · 非考勤依据”。

MVP 不采用：

- 设备指纹；
- 反调试或混淆；
- 平台级硬件证明；
- 全网奖金榜；
- 将数据用于惩罚或正式绩效。

如果未来进入企业治理，强证明必须作为独立模块引入管理员托管安装、审计日志和厂商 attestation，不能把 v1 历史数据升级解释为考勤证据。

### 3.5 隐私与留存边界

Edge 永不上报：

- prompt、回复或消息正文；
- tool arguments、命令或输出；
- 项目名、路径或仓库；
- WorkBuddy `session_id`；
- 本地 spool 原文；
- Agent Mail OAuth token；
- 邮件正文或其他收件箱内容。

Edge 仅上报：

- Control Plane IDs；
- 客户端报告的 `display_state`、`activity_state`；
- `observed_at` 作为受限诊断字段；服务端另记 `received_at`；
- `boot_id`、单调 `sequence`、协议/客户端版本；
- 心跳与有限可靠性字段；
- 已选择的公开 `pet_id`。

留存：

- 当前 Presence/Lease：覆盖更新，不形成无界心跳日志；
- 详细派生状态区间：30 天；
- 每 Office/Mount 的日汇总：365 天，仅用于日榜、Award 重算与安全/完整性调查；不向 Owner 或历史分析 API 暴露；
- Daily Award：保留至办公室删除；
- 海报：客户端或服务端按需生成，默认不永久保存私人图片；
- Account/Office 删除后的彻底清理窗口：**提议默认 30 天，待隐私政策最终确认**。

公开端、Member 和 Owner 在 v1 都只看到实时状态、今日排行和 Daily Award；不提供个人历史空闲曲线、原始事件或导出。未来治理分析必须是单独同意、单独授权、单独数据域。

Account 删除时：

- 立即撤销浏览器 session、设备密钥和所有 Mount；
- 在清理窗口内删除状态区间与日统计；
- 历史 Award 若仍需随 Office 保留，将 alias/Account/Agent 引用改为不可回溯的“已离开的伙伴”占位身份；
- Office 删除则级联删除 Room、Mount、日统计与 Award。

**提议默认的附属 TTL：**challenge 10 分钟；发信/安全审计元数据 30 天；应用日志与错误追踪 14 天且脱敏；数据库备份最多 30 天。项目不默认上传海报到 CDN/object storage。已被用户下载或转发到社交平台的海报无法远程撤回，隐私说明必须明确这一点。

### 3.6 视觉参考的可复用边界

参考站适合借鉴：

- Petdex 的宠物预览、随机发现与易分享；
- Awesome Codex Pet 的中文优先、精选感和清晰留白；
- CodexPets.net 的大角色预览和简单选择；
- 单卡分享、轻互动和收藏感。

不应照搬：

- 搜索、筛选、安装量、分页构成的目录首页；
- 大号营销标题占据首屏；
- 把 11 个动作按钮作为常驻界面；
- 依赖影视/游戏 IP 角色传播；
- MVP 就做评论社区、3D playground 或投稿市场。

当前 15 只原创宠物足够支撑 v1 品牌阵容。多人办公室另建渲染层，现有单宠物 Tauri Canvas 保留为 Edge 桌宠。

### 3.7 部署、分发与中国大陆访问

- GitHub public repo 是源码真相。
- 官方实例是一个独立 Railway Project，不复用账号中其他 Railway 项目。
- Railway 上采用一个 Control Plane 服务和一个 PostgreSQL；MVP 不引入 Redis、Kafka、Temporal、Kubernetes或微服务。
- 必须提供 Docker/self-host 文档和 `CONTROL_PLANE_URL` 覆盖项。
- GitHub main CI 通过后才允许部署官方实例。
- GitHub tag 驱动 macOS/Windows 安装包与 GitHub Release。
- Tauri updater 只接受签名更新；用户确认后安装，不静默升级。
- 正式公开发布需要 macOS Developer ID + notarization 和 Windows code signing。
- 中国大陆对 Railway 的可达性、首屏时间和 SSE 稳定性不能凭假设验收；必须从真实网络测试。若不达标，后续更换官方托管位置不能改变 Edge/API/数据模型。

### 3.8 公开内容与运营安全

即使不展示真人信息，公开实例仍包含用户生成的 Office name、Agent alias 和分享海报，需要最小运营安全层：

- 字段长度、字符和速率限制；
- Office Owner 移除 Member/Mount；
- 邀请 token 哈希存储、过期和撤销；
- 服务运营方可暂停违法/滥用 Office，但这不是 Office 内的 Admin 角色；
- 举报、隐私、删除与 takedown 入口；
- 日志中默认脱敏邮箱、token 和设备凭证。

## 4. Open questions ranked by leverage

1. **事务邮件服务与发信域名**

   阻塞 Agent Mail/普通邮箱挑战的真实端到端认证。建议定义 `MailSender` adapter，官方实例选择一家事务邮件服务，自托管支持 SMTP；不得复用用户本地 Agent Mail token。

2. **签名证书准备情况**

   不阻塞内部开发，但阻塞面向非技术用户的正式发布。需要 Apple Developer/Developer ID/notarization secrets 和 Windows code-signing secret。

3. **Windows WorkBuddy 真实集成证据**

   阻塞“macOS + Windows 可用”的验收。需要在真实 Windows + WorkBuddy 环境确认 Hook 配置、权限、安装、自启、唤起与卸载。

4. **官方域名与品牌**

   影响 magic link、deep link scheme、CORS/CSP、分享二维码、邮件 sender domain、签名标识和隐私文档，应该在公开 beta 前冻结。

5. **默认 Office 统计窗口**

   **提议默认** `Asia/Shanghai` 工作日 `09:00–18:00`，Owner 可配置时区、工作日和时段；修改只影响未来区间，不回写历史结果。

6. **公开实例运营与删除 SLA**

   需要确认举报联系方式、运营方暂停权限、备份保留与“删除后 30 天彻底清理”的政策文本。

这些问题无需阻止代码骨架、领域模型和本地状态语义修正，但对应功能在输入未满足前不得宣称生产完成。

## 5. Proposed direction and decisions

### 5.1 产品边界

#### v1 包含

- 官方实时示范办公室；
- 创建 unlisted Office；
- Owner 邀请、移除和转移 Office；
- Member 挂载/卸载自己的 Logical Agent；
- Guest 通过分享链接零登录观看；
- 实时办公室场景、成员 roster、今日咸鱼王小卡；
- 每日统计与 Daily Award；
- 可直接录屏的 `9:16` 宣发模式、`3:4` 小红书图文海报，以及公众号文章可用的办公室静帧；
- Agent Mail 优先验证、普通邮箱恢复；
- macOS 与 Windows Edge；
- GitHub Releases 和签名更新；
- 官方 Railway 实例与自托管。

#### v1 明确不包含

- 远程命令、执行、暂停或审批；
- 员工绩效、考勤、历史个人分析或 CSV 导出；
- 聊天、评论、点赞、宠物投稿市场；
- Google/GitHub 社交登录；
- 企业 OIDC/SAML；
- 3D 场景；
- 强反作弊；
- 多服务、消息队列、工作流引擎或 Kubernetes。

### 5.2 核心领域模型

```text
Account
  ├─ LoginIdentity
  ├─ owns -> LogicalAgent
  └─ Membership -> Office

Office
  ├─ Room (v1 自动创建 Lobby)
  ├─ Invite
  ├─ Membership
  ├─ OfficeScheduleVersion
  ├─ PublicViewToken
  ├─ AgentOfficeMount -> LogicalAgent
  ├─ OfficeDailyAgentStat
  └─ DailyAward

LogicalAgent
  ├─ AgentInstance
  ├─ active_reporting_instance_id (MVP 最多一个)
  └─ AgentOfficeMount (可挂多个 Office)

AgentInstance
  ├─ DeviceCredential / Ed25519 public key
  ├─ CurrentPresence / lease
  ├─ PresenceEligibilityInterval
  └─ DerivedActivityInterval
```

身份规则：

- 数据库主键全部是内部 UUID。
- `Account` 是人/所有者身份，不公开。
- `LoginIdentity` 以规范化邮箱地址作为可变登录标识并全局防重复，记录 `discovery_source = agent_mail | manual`；Agent Mail `alias_id` 只保存为 provider metadata，不作为主键。未来 `agent_mail_oauth`/`MailboxConnection` 使用不同的 identity/connection 类型。
- `LogicalAgent` 是公开稳定 Agent 身份，拥有 alias 与 `pet_id`。
- `AgentInstance` 是某次安装/设备，不等于 Agent。
- 一个 Logical Agent 可以保留多个历史/已撤销 Instance，但 MVP 同时只有一个 active reporting instance；需要第二个并行 Agent 时创建另一个 Logical Agent。
- `AgentOfficeMount` 决定一个 Agent 在某个 Office/Room 的出现、排序和统计资格。
- Mount 不授予远程控制权。
- Device、session、outbox 和 Account namespace 必须绑定到 `control_plane_origin + server_id`；切换自托管实例需要重新 enrollment。

### 5.3 权限模型

| 角色 | 能力 |
| --- | --- |
| Owner | 管理 Office、可见性、统计窗口、邀请、移除成员/挂载、转移或删除 Office |
| Member | 管理自己的 Agent、设备和 Mount；查看与 Guest 相同的实时/今日趣味数据 |
| Guest | 通过链接只读查看实时办公室、今日排行与 Daily Award |

- MVP 不设置 Office Admin。
- Office Owner 也看不到原始事件、邮箱、私人历史或成员设备秘密。
- 普通分享链接只能观看；只有独立 `/join/:token` 邀请链接可以加入。
- Member 只能管理自己 Account 所属的 Logical Agent、Instance 和 Mount；Membership 不能扩大到其他 Office。
- 每个 Mount 独立保存 `presence_visible`、`stats_opt_in`、`poster_opt_in`；
  加入时显式说明。snapshot/SSE 的场景 `agents` 只按 `presence_visible`
  过滤；leaderboard 与 Daily Award 只按 `stats_opt_in` 过滤；新海报中的
  场景形象要求 `presence_visible + poster_opt_in`，统计/奖项要求
  `stats_opt_in + poster_opt_in`，`poster_opt_in` 不能扩大前两项授权。
  任一授权撤回都递增 `office_revision`，下一份 snapshot/SSE 和此后新生成的
  海报立即移除对应内容；已下载的历史图片不承诺远程召回。
  已结算 Award 的底层不可变记录不改派；winner 撤回 `stats_opt_in` 后，公开
  projection 将 `daily_award` 置空，恢复同意后才可重新公开原记录。
- 移除 Membership 或 Member 自行退出只移除该 Office 的 Mount，不撤销其他 Office 的 Mount 或全局设备。
- Owner 转移只能给已验证的现有 Member，必须在一个数据库事务内完成并始终保证 Office 恰有一个 Owner；最后一个 Owner 不能直接退出。
- Invite 只授予 Member，token 哈希存储、过期、撤销且不能由客户端自报角色。
- unlisted 只是“不进入目录”，不是强访问控制。Office 公共名称与高熵 `public_view_token` 分离，token 只保存哈希，Owner 可轮换/撤销分享链接。
- v1 不开放用户 Office 公共目录；schema 保留 `discoverability`，只有官方示范 Office 可被列出。公开目录以后单独增加发布提示、Mount 同意和 moderation。
- 删除 Office、删除 Account、转移 Owner、撤销全部设备等危险操作需要重新认证和明确确认。

### 5.4 摸鱼计分规则

对一个 Mount，连续可计区间定义为：

```text
eligible_idle_interval
  = client reports eligible-idle activity
  ∩ active reporting instance lease
  ∩ Mount active
  ∩ stats_opt_in
  ∩ Office schedule window
```

15 分钟 grace 对每个连续交集区间单独计算。以下任何变化都切断区间，恢复后重新计算 grace：

- 有意义的活动或不可计状态；
- Lease 到期、设备接管或换 boot；
- Mount 失效；
- 退出 `stats_opt_in`；
- Office 统计窗口关闭；
- Owner 的 schedule 新版本生效。

计分语义：

- 15 分钟 grace 本身不计入摸鱼总时长；从第 15 分钟开始累计。
  - **提议默认，需在首个统计测试里显式锁定。**
- 有意义的 WorkBuddy 活动会结束空闲区间并重置 grace。
- 信息通知不重置。
- 等待审批、等待用户回答和失败状态不计。
- `idle_prompt`、任务完成、等待新任务属于可计空闲。
- 断网、退出、心跳过期不计；恢复后不补算离线或超期 outbox。
- 25/35/60 分钟只改变视觉，不加权。
- 一个 Agent 同时挂载多个 Office 时，同一 presence 可以按各 Office 的时区/窗口分别投影与计分。
- Daily Award 是 Office-wide，不按 Room 分割。
- 相同时长时优先更早达到该时长者；仍相同则按稳定 Agent ID 升序，保证
  确定性。`score_reached_at` 与 stable Agent ID 只用于服务端排序，不进入
  public snapshot。
- 服务端 `received_at` 决定活动区间起止；`observed_at` 最大允许偏差作为配置项并只用于诊断。新 boot 的有效起点不得早于服务端首次接受该 boot 的时间。
- `idle_stage` 由服务端按当前连续有效空闲时长派生；客户端报告值只能用于本地立即显示，不能进入统计。
- Office 场景对非摸鱼动作可使用已认证 Edge 报告的 display state；进入摸鱼阶段后以服务端派生的 `idle_stage` 覆盖，确保视觉与榜单采用同一连续区间。
- Office schedule 带版本与 `effective_at`；修改默认从下一个 Office day 生效，不重算历史。
- 跨午夜窗口归属于窗口开始所在的 Office local date。
- “今日榜”是实时暂定结果；Daily Award 在 Office day 结束且最后一个可能 Lease 到期后结算为不可变记录。迟到客户端事件不能改写已结算 Award。

### 5.5 Edge 协议

建议版本化端点：

```text
POST /api/v1/auth/email/challenges
POST /api/v1/auth/email/verify
POST /api/v1/edge/enrollment/challenges
POST /api/v1/edge/enrollment/verify
POST /api/v1/invites/:token/redeem
POST /api/v1/edge/events:batch
POST /api/v1/edge/heartbeat
POST /api/v1/edge/device:revoke
GET  /api/v1/offices/:public_view_token/snapshot
GET  /api/v1/offices/:public_view_token/events   (SSE)
```

上报 envelope 最小字段；`events` 是有界数组，状态事件与心跳共享同一个 per-boot 单调序列空间：

```json
{
  "protocol_version": 1,
  "instance_id": "uuid",
  "key_id": "uuid",
  "boot_id": "uuid",
  "previous_boot_id": "uuid-or-null",
  "first_sequence": 42,
  "events": [
    {
      "sequence": 42,
      "kind": "state_transition",
      "observed_at": "RFC3339",
      "display_state": "working",
      "activity_state": "active",
      "pet_id": "sora-shiba"
    }
  ],
  "sent_at": "RFC3339",
  "client_version": "0.1.0",
  "signature": "base64-ed25519-signature"
}
```

Boot/乱序规则：

- 每个 envelope 必须携带 `previous_boot_id`：实例首个 boot 为 `null`；已有当前
  boot 时，新 boot 必须精确引用它，服务端以 compare-and-swap 建立下一代
  fencing generation；
- 新 boot 的 sequence 1 必须是完整 `state_transition` 当前快照；无可靠
  WorkBuddy 信号时使用 `display_state=idle + activity_state=unknown`。批内后续
  可跟 heartbeat，当前态取最后一个 state transition；
- 已知旧 boot 和此前未到达服务端的延迟旧 boot 都不得反向接管，也不得改变
  CurrentPresence、Lease、grace 或计分；
- 每个 boot 的 sequence 从 1 开始严格递增，事件与心跳使用同一空间；
- 重启时丢弃旧 boot 中尚未确认、且只能用于历史回填的 outbox；当前状态以新 boot 首个快照重新开始；
- `observed_at` 超出允许偏差仍可记录为诊断，但统计使用服务端时间；
- batch 以 `instance_id + boot_generation + sequence` 幂等。
- v1 batch 最多 64 个事件并原子处理；gap、部分 overlap 或同 sequence 不同 canonical payload 均整批拒绝，不产生部分副作用；
- 当前 boot 的完整 canonical payload 整批重放返回原 ACK 且不续租、不重复
  计分；已被 fence 的 boot 优先返回 `stale_boot`，不再取回旧 ACK。这与“同
  sequence 不同内容冲突”明确区分；
- `/edge/heartbeat` 使用相同 envelope，但只允许当前已建立 boot 的一个
  heartbeat event；它不能建立新 boot，并与状态事件共用同一 sequence 空间；
- v1 明确 `current_protocol = min_supported_protocol = 1`，不虚构 v0；从 v2 开始才实际启用 N/N-1 双版本窗口。

Edge 实施边界：

- 在 Tauri 后端增加 `identity` 与 `reporter` 模块，不让网络错误影响本地桌宠。
- 非秘密 identity 配置使用权限收紧的本地文件；设备私钥/token 使用 OS keystore。
- 状态变化立即进入有界 outbox；心跳按固定间隔发送；失败指数退避。
- outbox 只存派生状态，不存本地 spool、session/tool/project/mail 内容。
- watcher 完成首次 catch-up 后再发送首个快照。
- 宠物选择从 WebView `localStorage` 同步到 Rust/Logical Agent 配置，`activeKey` 不能充当 Agent ID。
- GUI 调用 Agent Mail CLI 时记录并使用绝对路径，不能假定继承 shell `PATH`。
- 本地 loopback `/state` 和审批端口继续只服务本机，不能接入 Control Plane。
- 设备公钥长期注册但可轮换/撤销；Account 删除立即撤销全部设备。浏览器 session 使用 Secure、HttpOnly、SameSite cookie，并与设备签名身份分离。
- `CONTROL_PLANE_URL` 切换时按 origin/server ID 隔离凭证与 outbox，强制重新 enrollment；生产默认只允许 HTTPS，loopback 仅限显式开发模式。

### 5.6 Control Plane 架构

```text
Browser / Share Link
        |
        | HTTPS REST + SSE
        v
TypeScript Modular Monolith
  ├─ Identity
  ├─ Offices & Membership
  ├─ Agents & Devices
  ├─ Presence
  ├─ Slacking Statistics
  ├─ Sharing / Poster
  └─ Operations / Moderation
        |
        v
PostgreSQL
```

架构约束：

- 单一可部署服务，内部按领域模块隔离。
- PostgreSQL 是账户、配置、状态区间、日统计和 Award 的事实源。
- snapshot 返回单调 `office_revision`；SSE event id 使用相同 revision，并支持 `Last-Event-ID/after_revision` 与短期重放，避免 snapshot 到建连之间漏事件。
- 如果客户端 revision 已超出短期重放窗口，则重新获取 snapshot；重复 revision 必须幂等。
- Railway MVP 先固定单应用副本。扩容多副本前使用 PostgreSQL transactional outbox + `LISTEN/NOTIFY`（或等价持久事件表）做 fan-out，不把进程内广播误当成跨副本真相。
- OpenAPI/JSON schema 是 Edge 与服务端的版本契约。
- 服务端支持当前协议 N 与上一版 N-1，并发布 `min_supported_protocol`；强制升级必须保留回滚窗口，不能在服务端部署时立即让仍可工作的 Edge 全部失效。
- 所有写接口幂等；数据库约束保证重复 batch 不重复计分。
- 日结算使用单进程定时任务加 PostgreSQL advisory lock，并以 OfficeScheduleVersion 与 office-day 唯一约束保证幂等；读取时可以触发补偿结算，但不能改写已完成 Award。
- Web 技术栈具体框架属于实施默认：优先选择能在单 Railway Service 中运行、支持 React 场景、REST/SSE 和可测试领域层的轻量方案，不将业务规则写入路由组件。

### 5.7 Office 场景与传播闭环

路由建议：

```text
/                  官方实时示范办公室
/o/:share_id       Office 只读/成员视图；share_id 为高熵可轮换 public_view_token
/join/:token       独立邀请入口
/share/:share_id   9:16 动态宣发模式与 3:4 海报生成入口
/download          GitHub Release 下载选择
/privacy           隐私与数据说明
/report            举报/删除入口
```

首屏：

- 70–80% 空间用于动态像素办公室；
- 宠物位于工位、沙发、茶水间等固定 slot；
- 宠物上方只显示 Agent alias 与极短状态；
- 今日咸鱼王以悬浮小卡展示；
- roster 和详细统计折叠；
- Guest 不先遇到登录墙；
- 唯一主 CTA 是“领一间我的办公室”或邀请态下的“把我的 WorkBuddy 搬进来”。
- 页面以 `zh-CN` 为首发语言，保留 locale 切换；在微信内置浏览器和常见移动端宽度下仍可直接围观与分享。
- 官方示范办公室若使用模拟 Agent，必须显著标注“演示数据”；若使用真实团队 Agent，必须逐 Mount 获得公开、参赛与海报同意。

传播闭环：

```text
办公室/海报被分享
  -> Guest 零登录围观
  -> 安装或唤起 Edge
  -> Agent Mail 优先验证
  -> 普通链接自动创建 unlisted Office
     或邀请链接加入目标 Office
  -> 挂载宠物
  -> 邀请下一位成员
  -> 每日生成咸鱼王海报
```

Room：

- v1 每个 Office 自动创建一个 `Lobby`；
- 每个 Room 同屏最多 24 只宠物；
- 超出者继续显示在 roster，不挤进场景；
- 数据模型从第一天保留 `room_id`，但 v1 不暴露复杂房间管理。

分享内容采用同一个 `ShareComposition` 数据模型，避免视频、海报和文章配图各自拼装隐私字段。

`9:16` 短视频宣发模式：

- 画布基准 `1080 × 1920`，核心标题、宠物与二维码避开平台顶部/底部交互遮挡区；
- **提议默认**提供 12–15 秒可循环时间线：
  - 0–3 秒：“今天谁是咸鱼王？”或办公室现场钩子；
  - 3–9 秒：多人办公室状态与摸鱼形态演出；
  - 9–12 秒：冠军揭晓；
  - 12–15 秒：办公室链接、开源标识与 CTA；
- MVP 先交付确定性、可直接屏幕录制的纵向模式，不把服务端 FFmpeg/MP4 编码绑进 Control Plane 核心；自动 MP4 导出通过独立 renderer 接口后续加入；
- 默认不内置第三方平台音乐；创作者可在抖音、视频号或小红书发布流程中添加平台音乐，避免音乐版权进入项目供应链。

`3:4` 小红书图文：

- 画布基准 `1080 × 1440`；
- 生成封面版与结果版，保持宠物、标题、结果和二维码在移动端可读；
- 可组合成多图：办公室全景、四级摸鱼变化、今日冠军、加入方式。

公众号文章：

- 可复用 3:4 卡片，并提供干净的办公室静帧/横向辅助图；
- 不把公众号封面尺寸硬编码进领域模型，输出由 ShareComposition 的 viewport/preset 决定。

公开分享字段：

- Office 公开名、日期、时区；
- “今日咸鱼王”；
- 冠军 Agent alias 与宠物大图；
- 当日有效摸鱼时长；
- 第二、第三名的小头像和时长；
- 最多六只宠物的办公室缩略图；
- 趣味文案、实时链接二维码、GitHub/Open Source 标识；
- 固定“趣味统计 · 非考勤依据”；
- 不出现邮箱、真人姓名或私人历史。

### 5.8 GitHub、Railway 与 Release

仓库：

- 保持 `main` 为发布真相。
- 后续实施使用 `codex/` 前缀功能分支。
- 现有混合工作树必须先划清资产与 Control Plane 变更，逐文件 stage。
- 业务提交前先把已有宠物资源工作整理成独立提交或明确排除，不能混入架构提交。

Railway：

- 新建独立 Project；
- 一个 Control Plane Service + 一个 PostgreSQL；
- 在生产前建立与生产数据库、域名和 secrets 完全隔离的 staging 环境；
- secrets 只放 Railway Variables；
- migration 是显式部署步骤；
- `/livez` 只验证进程存活；`/readyz` 验证数据库连接与 schema 版本，避免数据库短暂故障触发应用重启循环；
- 首次上线前完成备份/恢复演练；
- `CONTROL_PLANE_URL` 可由自托管 Edge 覆盖。

GitHub Releases：

- PR/main：测试、格式、隐私 contract、协议 contract；
- version tag：macOS/Windows matrix build、签名、notarization、checksum、Release；
- Railway 只部署已通过 main CI 的服务代码；
- 安装包来自 GitHub Release，不来自 Railway；
- updater 签名私钥、Apple/Windows signing secrets 只存在 GitHub Secrets；
- secret scanning、依赖漏洞扫描和签名验证属于 Release gate；
- 坏版本处理必须保留上一签名安装包、服务端 N/N-1 兼容与明确降级说明，不能依赖一次不可逆的强制升级；
- `install.sh` 仅作为开发者源代码安装方式保留。

### 5.9 建议实施顺序

1. **Milestone 0 — 语义与契约**
   - 修正/拆分 display、activity、idle stage；
   - 写统计规则测试矩阵；
   - 定义 OpenAPI/JSON schema；
   - 保持现有本地桌宠行为可用。

2. **Milestone 1 — Control Plane skeleton**
   - TypeScript modular monolith；
   - PostgreSQL schema/migrations；
   - Office/Agent/Instance/Mount/Presence 核心 API；
   - Docker/self-host；
   - 本地假 Edge 驱动 SSE 办公室。

3. **Milestone 2 — Real Edge enrollment**
   - identity、device key、outbox、heartbeat；
   - Agent Mail/ordinary email challenge adapter；
   - macOS 真实 Hook E2E；
   - 断网、重放、重启恢复。

4. **Milestone 3 — Viral office**
   - 多宠物场景；
   - 官方示范办公室；
   - invite/create flow；
   - 今日排行、9:16 宣发模式、3:4 图文海报与公众号配图；
   - 隐私/举报入口。

5. **Milestone 4 — Windows and public beta**
   - Windows WorkBuddy live integration；
   - signed GitHub Releases/updater；
   - Railway production project；
   - 中国大陆网络验收；
   - 发布与回滚演练。

每个 Milestone 必须可独立演示、测试和回滚；未通过前不提前叠加后续企业治理功能。

## 6. Success criteria

### 6.1 状态与统计

- 单元测试覆盖 14:59、15:00、25:00、35:00、60:00 边界。
- 信息通知不重置 grace；有效活动会重置。
- Waiting for approval/user answer 与 Failed 不计；idle prompt、Done、waiting for new task 可计。
- Lease 在精确到期时点切断连续区间，恢复后重新计算 grace 且不补算离线区间。
- 双 Instance 并发、显式设备接管、修改客户端时钟、旧 boot 回放、超期 outbox、重复和乱序事件都不会重复累计或跳过 grace。
- 新 boot 接受后旧 boot 不再改变 CurrentPresence；服务端时间与客户端时间偏差用例通过。
- Office 时区/窗口边界和跨午夜正确。
- 退出 opt-in、卸载 Mount、窗口关闭或 schedule version 生效都会切断连续区间。
- 同一 Agent 投影到两个 Office 时按各自窗口独立结算。
- “实时暂列冠军”与最终 Daily Award 明确区分；Award 在重复执行结算时结果幂等、确定且不会被迟到 Edge 事件改写。

### 6.2 隐私与安全

- 自动隐私 contract 断言上报 payload 不含 prompt、message、tool args、path、session、mail body 或 OAuth token。
- Agent Mail token 从不离开 CLI/OS keychain。
- 自动读取 challenge 必须由用户在本次 enrollment 中显式同意，只执行一次精确查询；浏览器 magic link/手工 OTP 不依赖 `mail:read`。
- 过期、已使用或绑定到其他设备/邀请的 challenge 被拒绝。
- 已撤销设备、错误签名和重复 sequence 被拒绝。
- Guest、Member、Owner 的越权 API 测试全部通过。
- 每个 Mount 的公开、参赛、海报 opt-in 均有授权测试；撤回后 snapshot、SSE、排行和新海报立即不再包含该 Mount。
- unlisted public view token 不可枚举、可轮换、可撤销；旧链接失效。
- 浏览器 session 使用 Secure/HttpOnly/SameSite cookie；状态修改接口通过 CSRF、CORS 和 CSP 测试。
- auth/邀请/Edge 写入接口具备 IP、Account、email/device 维度 rate limit；登录响应不泄露邮箱是否存在。
- 发信域名通过 SPF、DKIM、DMARC；challenge 单次、10 分钟过期、尝试次数受限，重复点击幂等。
- 日志与错误跟踪不记录完整邮箱、邀请 token、设备 token 或验证码。
- Account/Office 删除流程有可验证的清理任务与审计状态；Account 删除后的 Award 匿名化、备份到期清理和设备立即撤销均有测试。

### 6.3 Edge 可靠性

- Control Plane 不可用时，本地桌宠、Hook 与审批仍正常。
- 网络恢复后只补传当前 boot 中仍有效的有界派生状态，不上传原始 spool，也不为 Lease 失效时段补分。
- 重启不先上报虚假 Idle。
- 切换 `CONTROL_PLANE_URL` 不会把旧 origin 的凭证或 outbox 发往新服务，且必须重新 enrollment。
- macOS 与 Windows 均完成：安装、WorkBuddy 重启、状态变化、自启、升级、卸载、断网恢复的真实 E2E。
- GUI 不依赖 shell `PATH` 就能找到已安装的 Agent Mail CLI。

### 6.4 Web 与传播

- Guest 打开 `/` 或 `/o/:share_id` 不登录即可看到有效快照。
- snapshot revision 与 SSE `Last-Event-ID` 测试覆盖建连窗口、短期重放、gap fallback；断线恢复不丢状态且不会产生重复宠物。
- 24 只宠物在基准桌面浏览器保持至少 30 FPS、页面内存低于 250 MB；基准移动端降级后保持至少 24 FPS。
- 单 Railway 应用副本的 beta load test 支持 500 个并发 Guest SSE，错误率低于 1%，状态推送 p95 小于 1 秒。
- 公开页面不出现邮箱、真人姓名或私人历史。
- 公开 snapshot/SSE/今日排行/海报只包含该 Office 中已明确 opt-in 的 Mount。
- 公开链接不能挂载；有效邀请链接才能加入。
- 首次验证后的普通用户无需选择表单即可自动得到 Office 并挂载宠物。
- `1080 × 1920` 宣发模式在抖音、视频号和小红书的常见 UI 遮挡下仍保留核心标题、冠军宠物和 CTA；基准设备保持至少 30 FPS。
- `1080 × 1440` 小红书海报在手机端文字清晰、二维码可扫描；公众号静帧在文章正文宽度下保持可读。
- 12–15 秒默认时间线可确定性重放，录屏不会出现资源加载占位、宠物跳帧或结果变化。
- 海报固定带“趣味统计 · 非考勤依据”。

### 6.5 发布与运行

- main CI 包含 Rust、TypeScript、数据库迁移、隐私、协议和关键 E2E。
- staging 与 production 的 Railway Project/Environment、PostgreSQL、域名和 secrets 隔离。
- 协议兼容测试覆盖服务端 N 与 Edge N/N-1；不支持的旧版收到可理解的升级提示，服务端回滚不破坏仍受支持的 Edge。
- GitHub tag 可重复地产出 macOS/Windows 安装包、checksum 与 updater artifacts。
- 正式版安装包通过平台签名/公证检查。
- Railway `/livez`、`/readyz`、迁移失败回滚、签名坏版本降级、备份恢复演练通过；beta 目标 RPO 不超过 24 小时、RTO 不超过 4 小时。
- 从至少三种中国大陆真实网络各执行至少 20 次访问：成功率不低于 95%，Office 初始可见快照中位数不超过 3 秒、p95 不超过 8 秒，SSE 断线后 10 秒内恢复；GitHub 安装包需完成真实下载。
- 事务邮件在 Agent Mail 与至少一个普通邮箱提供商各测试 20 次，成功率不低于 95%，p95 到达时间不超过 60 秒。
- 自托管者可以用文档化命令启动 Control Plane + PostgreSQL，并让 Edge 指向自定义 URL。
- 自托管升级覆盖 N-1 -> N migration、失败回滚和 origin-bound 重新 enrollment。

### 6.6 产品边界

- UI、隐私说明与文档均明确“趣味统计、非考勤依据”。
- v1 不存在远程控制入口或隐性命令通道。
- Office Owner 无法查看成员原始 WorkBuddy 事件。
- 未来治理模块必须新建权限、审计和数据同意边界，不能直接扩大 v1 Mount 权限。

## 7. Remaining risks and inputs needed

### 实施开始前可使用提议默认值

- Office 默认 `Asia/Shanghai`、工作日 `09:00–18:00`；
- 15 分钟 grace 不回溯计入前 15 分钟；
- Invite 默认 7 天过期、可撤销，token 只保存哈希；
- Presence heartbeat **提议默认** 30 秒、lease TTL 90 秒；作为服务端配置与协议返回值，不硬编码成产品常量；
- 客户端 `observed_at` **提议默认**允许偏差 ±5 分钟，但永不作为计分权威时间；
- Device registration **提议默认** 180 天有效，可由仍有效的设备密钥自动续期；过期、Account 删除、显式撤销或设备接管后必须重新 enrollment；
- Account/Office 删除后 30 天内完成彻底清理；
- Web 选择轻量 React 场景 + TypeScript API，但领域逻辑必须与路由/UI 隔离；
- 分享输出使用统一 ShareComposition；MVP 提供 9:16 可录屏模式与 3:4 静态导出，自动 MP4 编码不阻塞首个 beta；
- 首批仅使用仓库原创宠物，不开放第三方投稿。

### 用户或外部输入

- 官方域名和最终品牌名；
- 事务邮件 provider、sender domain 与相关 secret；
- Apple Developer/Developer ID/notarization 凭证；
- Windows code-signing 方案；
- Windows WorkBuddy 测试环境；
- 隐私政策、举报/删除联系方式；
- Railway 在中国大陆真实访问测试结果。

### 必须保持的停止线

- 本 brief 未签署前，不开始 Control Plane 业务实现。
- 未完成真实 Agent Mail challenge E2E，不宣称 Agent Mail 登录完成。
- 未获得厂商 attestation 前，不宣称能证明“真实且未修改的 WorkBuddy 活动”。
- 未完成真实 Windows WorkBuddy E2E，不宣称 Windows 支持。
- 未签名/公证，不把安装包作为正式公众版推广。
- 未完成中国大陆网络验证，不把 Railway 官方实例描述为国内稳定可用。
- 未建立独立权限与审计模型，不加入任何远程控制功能。
