# 给你的 WorkBuddy 养只桌宠：hooks + 本地会话文件实战

> 我给腾讯 WorkBuddy 做了一只开源桌面宠物 **workbuddy-buddy**：WorkBuddy 在思考、跑工具、等你确认还是干完了，屏幕角落这只小柴犬一眼就能看出来；甚至可以点它的气泡直接批权限、点它一下把 WorkBuddy 窗口拉到最前。
>
> 这篇把过程里最有料的部分拆开讲——**WorkBuddy 到底能不能挂 hook、本地会话文件长什么样、怎么在不碰你任何对话内容的前提下感知它的状态**。据我所知这是目前唯一一份 WorkBuddy hooks 的实测记录（官方还没有文档）。
>
> 仓库（MIT，欢迎 star / 贡献你自己的宠物）：**https://github.com/FlashFamily/workbuddy-buddy**
>
> *声明：本项目与腾讯、WorkBuddy 无任何隶属或背书关系，「WorkBuddy」仅用于描述兼容性。文中的本地文件结构、hook 行为均为个人实测，属未公开的内部实现，随版本更新可能变化。*

---

## 一、缘起：Codex 有宠物，WorkBuddy 也该有

OpenAI 的 Codex 今年内置了「Codex Pets」——一只挂在屏幕上的小动物，Codex 在思考时它转圈、要你确认时它举红铃、干完了打绿勾。社区顺势长出一整套生态：素材站几千只宠物、十几个第三方桌宠、甚至同步到 Garmin 手表。

我平时用腾讯的 **WorkBuddy**（腾讯云 CodeBuddy 团队出的桌面 AI 工作台）跑任务，经常一边等它一边刷别的，回头发现它早就停在「等我确认」了。于是想：能不能也给 WorkBuddy 挂一只这样的状态宠物？

一只宠物要能反映 agent 的状态，前提是**它得能感知 agent 在干什么**。Codex 靠的是官方 hooks + 本地会话日志。WorkBuddy 有没有对应的东西？这就是整件事的第一个、也是最关键的未知。

先看成品——同一只柴犬，七种状态：

![七种状态](https://raw.githubusercontent.com/FlashFamily/workbuddy-buddy/main/docs/img/states.png)

---

## 二、核心实测：WorkBuddy 能挂 hook 吗？

**能。** 而且和 Claude Code 的 hooks 几乎同构（WorkBuddy 底层引擎和 CodeBuddy CLI 同源）。

### 配置在哪

用户级配置在 `~/.workbuddy/settings.json` 的 `hooks` 字段，格式和 Claude Code 一模一样：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "/path/to/your-hook.sh UserPromptSubmit" }] }
    ],
    "PreToolUse": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "/path/to/your-hook.sh PreToolUse" }] }
    ]
  }
}
```

同源的 CodeBuddy CLI 官方文档列了 **26 个事件**（PreToolUse / PostToolUse / UserPromptSubmit / Stop / PermissionRequest / Notification / SessionStart …）。但「文档里列了」不等于「WorkBuddy 桌面版真的会触发」——这得实测。

### 实测：哪些真的会触发，payload 长什么样

我写了个探针脚本挂上去，跑一个真实任务（让 WorkBuddy 在一个小程序工程里改代码），一次任务打满了整条生命周期：

| 事件 | 触发 | payload 关键字段 |
|---|---|---|
| `SessionStart` | ✅ | `session_id` `source` `transcript_path` |
| `UserPromptSubmit` | ✅ | `prompt` `session_id` `permission_mode` |
| `PreToolUse` | ✅（一次任务 100+ 次）| **`tool_name` `tool_input`** `call_id` `transcript_path` |
| `PostToolUse` | ✅ | `tool_name` `call_id` |
| `PermissionRequest` | ✅ | `tool_name` `permission_mode` |
| `Notification` | ✅ | `notification_type`（实测见到 `auth_success` / `idle_prompt`）|
| `Stop` | ✅ | **`last_assistant_message`** `session_crons` `background_tasks` |

几个对做宠物特别有用的点：

- **每个 payload 都带 `transcript_path` 和 `session_id`**——等于 WorkBuddy 主动告诉你「该读哪个会话文件、属于哪个会话」，多会话仲裁的路由问题白送。
- `PreToolUse` 带 `tool_name` + `tool_input`，可以区分「只读工具（Read/Grep）→ 在看」和「写工具（Write/Bash）→ 在改」。
- `Stop` 带 `last_assistant_message`，可以判断「agent 是不是以一个问句结尾」——如果是，说明它在等你回答，宠物应该显示「等待」而不是「完成」。

### 本地文件：另一条感知通道

除了 hook，WorkBuddy 在 `~/.workbuddy/` 下明文落盘了不少东西（同样是第三方实测、非官方承诺）：

```
~/.workbuddy/
├── workbuddy.db                       # SQLite：sessions 表（status / last_activity_at / mode / permission_mode …）
├── projects/<工作目录编码>/<会话id>.jsonl   # 对话转录，每行一事件（message / reasoning / function_call / …）
└── sessions/<pid>.json                # 活跃进程心跳（pid / cwd / endpoint / version）
```

`projects/*.jsonl` 里 `reasoning` 行 = 在思考、`function_call` 还没配对 `function_call_result` = 正在执行工具——这是 hook 之外的兜底信号源。

---

## 三、架构：hook → 事件流 → 状态机 → 宠物

拿到「能挂 hook」这个地基，整条链路就清晰了：

```
WorkBuddy ──hook──▶ 隐私投影脚本 ──▶ events.spool（JSONL）
                                          │
                                   tail 事件流 → 状态机（7态 + 优先级仲裁 + TTL衰减）
                                          │
                                   Tauri 透明悬浮窗渲染精灵
```

### 第一原则：只碰状态，不碰内容

宠物只需要知道「WorkBuddy 在哪个状态」，**完全不需要**你的 prompt、命令参数、对话正文。所以在最上游的 hook 脚本里就做「隐私投影」——只挑结构字段，正文当场丢掉：

```python
def project(event, payload):
    d = payload if isinstance(payload, dict) else {}
    return {
        "event": event,
        "ts": int(time.time() * 1000),
        "session_id": d.get("session_id"),
        "tool_name": d.get("tool_name"),          # 结构信息（如 "Read"），不是参数
        "permission_mode": d.get("permission_mode"),
        "notification_type": d.get("notification_type"),
        # 「末句是不是问句」当场算成布尔，原文不留：
        "ends_with_question": ends_with_question(d.get("last_assistant_message"))
                              if event == "Stop" else None,
    }
```

`prompt` / `tool_input` / `last_assistant_message` 这些含内容的字段，一个都不写进磁盘。项目里有一条硬测试专门守这个契约：往投影器塞 `SECRET`、`/etc/passwd`、整段消息，断言落盘文件里一个字都搜不到。

### 状态机：7 态 + 仲裁 + 衰减

核心是一段纯逻辑（Rust，无 I/O，好测），把事件映射成 7 个状态，并解决两个现实问题：

```rust
pub enum State { Idle, Thinking, Working, Review, Waiting, Done, Failed }

// 多个会话同时在跑时，宠物显示「最要紧」的那个：
// failed > waiting > working > review > thinking > done > idle
// 没有「会话结束」事件？给每个状态一个存活时长（working 3分钟、waiting 24小时…），
// 到点自动淡回 idle——照搬 Codex 官方宠物的做法。
```

`Notification` 里那个 `idle_prompt`（agent 空闲、在等你）就映射成 `waiting`——这条是靠真实任务的数据才发现的：WorkBuddy 干完一轮会发 `idle_prompt`，宠物据此显示「该你了」。

---

## 四、进阶：让宠物直接当审批 UI

前面都是**单向**的（WorkBuddy → 宠物显示）。真正好玩的是**双向**——WorkBuddy 要跑一条命令、需要你批准时，宠物弹一个「允许 / 拒绝」气泡，你点一下，决定直接回传给 WorkBuddy。

这里有个 make-or-break 的未知：**WorkBuddy 会执行 hook 返回的决定吗？** 我先挂了个「无脑拒绝」的探针，让它拒掉所有 `Bash`，然后跑「运行 ls」。结果：命令被拦、agent 收到拒绝理由后改用别的工具绕路——**hook 的决定确实被执行了，而且在「不询问(dontAsk)」模式下也生效**（hook 决定的优先级高于权限模式）。

确认机制成立后，闭环就是：

```
WorkBuddy 要跑 Bash → hook 阻塞 → POST 到宠物的本地服务
   → 宠物弹气泡「WorkBuddy 请求 Bash + 命令预览 + 允许/拒绝 + 倒计时」
   → 你点按钮 → 决定回传 hook → WorkBuddy 执行你的选择
```

关键设计是 **fail-open**：宠物没开、你没点、超时了——hook 就静默退出，WorkBuddy 完全当宠物不存在。**一个状态指示器永远不该卡死你的正经工作流。**

---

## 五、踩坑实录（真实血泪，帮你少走弯路）

装好 hook 后我一度怎么都触发不了，排查出这么几条 WorkBuddy 的「反直觉」行为：

1. **hook 配置在启动时缓存**。改完 `settings.json` 必须**完全重启** WorkBuddy 才加载，热改无效。
2. **关窗 ≠ 退出**。WorkBuddy 有 Claw/IM 常驻能力，点关闭按钮只是关窗口，进程还活着（还在用旧配置）。得 `Cmd+Q` 彻底退出，或 `pkill -f WorkBuddy.app`。
3. **`dontAsk` 模式不产生 `PermissionRequest`**。想测权限相关的 hook，得先把会话权限模式切回「询问 / 默认」。
4. **没打开工作目录，任务根本不进 agent**。WorkBuddy 需要一个 workspace/文件夹才会真正跑 agent（也才会写 transcript、发 hook）。我一开始对着空状态发消息，什么都没发生，查了半天数据库才发现——压根没有新会话。

这四条没写在任何文档里，踩一遍能耗掉一下午。

---

## 六、上手 & 养你自己的宠物

一条命令搞定（macOS，需要 Rust；没有的话脚本会提示你装）——拉源码、编译、装 hook（自动备份 `settings.json`）、启动桌宠：

```sh
curl -fsSL https://raw.githubusercontent.com/FlashFamily/workbuddy-buddy/main/install.sh | bash
```

装完**完全重启 WorkBuddy**（Cmd+Q，配置是启动时缓存的），打开一个工作目录跑个任务，桌宠就动起来了。

内置 15 只手绘伙伴，托盘「选择伙伴」或右键宠物切换：

![15 只伙伴](https://raw.githubusercontent.com/FlashFamily/workbuddy-buddy/main/docs/img/buddies.png)

想加**你自己**的宠物，不用改代码、不用重编译——按 [PET_SPEC](https://github.com/FlashFamily/workbuddy-buddy/blob/main/docs/PET_SPEC.md) 做一张 7 状态精灵图，丢进 `~/.workbuddy-buddy/pets/你的宠物/`，打开选择器就出现了（带「自定义」标）。

---

## 七、结语：不止 WorkBuddy

因为感知层就是「hooks + 本地文件」这套通用机制，这只宠物其实不绑死 WorkBuddy——把 `WB_BUDDY_HOST_APP` 换个名字，就能给 Claude Code、Codex、CodeBuddy 用（它们的 hook 事件命名都对齐 Claude Code 约定）。

如果你也在用 WorkBuddy，欢迎 clone 下来养一只，或者贡献一只你设计的伙伴（PR 里放进 `frontend/pets/` 即可）。仓库在这：**https://github.com/FlashFamily/workbuddy-buddy** ⭐

> 再次声明：个人开源项目，与腾讯/WorkBuddy 无隶属关系；文中本地文件与 hook 行为为实测记录，非官方承诺，可能随版本变化。
