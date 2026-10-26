# handoffcheck

检查一份交接文档（`HANDOFF.md`）在另一个 agent 接手时**是否还成立**：commit 还在不在、文件有没有改、TODO 锚点是否还指向那一行、声明的命令还能不能跑通。零依赖；不调用模型。

> GitHub 仓库名是 `openbot-handoffcheck`，CLI 可执行名是 `handoffcheck`。

## 为什么

多个 coding agent 轮流接手同一个仓库时，状态靠一段人手写的 `HANDOFF.md` 传递。这段文字会过期，而没有任何机制在接手时校验它。

`handoffcheck` 只做校验，不做生成式补全：

- `/handoff` 一类 skill 负责**写**交接内容，本文档工具负责**验**它是否还成立，两者不冲突。
- `git status` 告诉你「有什么变了」，但不告诉你「交接里的哪句话因此不成立了」。
- 格式固定，解析失败直接报错退出，不做模糊匹配——模糊匹配会制造假阴性。

## 背景信号（2026-10-26 采集）

- [`reason-machines/reason-network`](https://github.com/reason-machines/reason-network)（GitHub，1,258 stars）："your team's coding agents, talking to each other"——多 agent 接力已经是产品形态。
- [`amosblomqvist/learnharness`](https://github.com/amosblomqvist/learnharness)（GitHub，2,132 stars）：harness 的卖点是跨会话持续推进同一件事，跨会话就必须传递状态。
- [`The State of Context Engineering`](https://dbreunig.com/2026/10/24/the-state-of-context-engineering.html)（HN，241 分 / 59 评论）：交接文档本质是人工做的 context engineering。

「交接会过期」是从上面这些推断出来的，不是有人在 issue 里的原话；star 和分数是采集时点的值。这个工具先解决我自己的问题：常驻 daemon 每一轮都在用文件跟下一轮交接。

## 安装

需要 Node >= 22 和 `git`。没有第三方依赖，不需要 `npm install`。

```bash
node src/cli.mjs --help
```

不想每次写路径，可以在本目录执行 `npm install -g .`，之后用 `handoffcheck`。

## 一条命令

在一个仓库里先生成交接，再让另一个 agent 接手：

```bash
node src/cli.mjs init --files src/checkout.mjs,src/api.mjs   # 换成你自己的文件
# ... 另一个 agent 改了代码 ...
node src/cli.mjs check HANDOFF.md
```

`check` 的真实输出（`demo/demo.mjs` 在临时仓库里跑出来的，见下）：

```text
HANDOFF.md   schema handoffcheck/v1
  repo demo-repo · branch main · commit 99c92f183d9c · created 2026-10-26T16:11:58.836Z
  HEAD 14a490f6ce83（main）

  ⚠ commit 99c92f183d9c  是 HEAD 的祖先，但已落后 1 个提交
  ✓ branch main  当前就在 main
  ✓ 文件 src/api.mjs  2a0f696f6dfc 未变
  ✗ 文件 src/checkout.mjs  hash 变了：483ab3fdffe7 → ecfb709ebebe
  ✗ 锚点 src/checkout.mjs:2  这一行已经没有该文本：// TODO: retry on 409
  · 命令 1 条声明  未执行（加 --run 跑一遍，核对退出码）

  2 stale · 1 warn · 2 ok · 1 info  →  exit 1

  先修掉 ✗ 再接手，或重跑 handoffcheck init --force 重写交接。
```

`exit 1` 的意思是：这份交接里有 2 条已经不成立了。接手前先修，或者重写一份：

```bash
node src/cli.mjs init --force --files src/checkout.mjs,src/api.mjs
```

刚写完时同一份文件是这样的（`0 stale · 0 warn · 5 ok · 1 info → exit 0`）：

```text
  ✓ commit 99c92f183d9c  就是当前 HEAD
  ✓ branch main  当前就在 main
  ✓ 文件 src/api.mjs  2a0f696f6dfc 未变
  ✓ 文件 src/checkout.mjs  483ab3fdffe7 未变
  ✓ 锚点 src/checkout.mjs:2  仍在第 2 行
  · 命令 1 条声明  未执行（加 --run 跑一遍，核对退出码）
```

## 交接文档格式

`init` 生成，三张表是唯一被 `check` 认的东西，其余文字不校验：

````markdown
# HANDOFF

```handoff
schema: handoffcheck/v1
repo: demo-repo
branch: main
commit: 99c92f183d9c
created: 2026-10-26T16:11:58.836Z
author: demo-agent
```

## Files

| path | sha256 | note |
| --- | --- | --- |
| src/api.mjs | 2a0f696f6dfc |  |
| src/checkout.mjs | 483ab3fdffe7 | 退款流程 |

## Anchors

| path | line | snippet |
| --- | --- | --- |
| src/checkout.mjs | 2 | // TODO: retry on 409 |

## Commands

| command | expect_exit |
| --- | --- |
| npm test | 0 |

## State

退款主流程跑通；409 重试还在 TODO。
````

- `sha256` 是文件内容 sha256 的前 12 位，**先统一 CRLF → LF 再算**，所以 Windows 和 macOS 的 checkout 不会互相误报。
- `Anchors` 检查的是「第 N 行还包含这段文本吗」。行号漂移报 warn（`文本移到了第 N 行`），文本消失报 stale。
- `Commands` 只有加 `--run` 才真的执行；`expect_exit` 写 `skip` 表示只记录不跑。

## 检查项

| 检查 | 判定 |
| --- | --- |
| commit 是否存在、是否为 HEAD 祖先 | 不存在 / 不是祖先 → stale；祖先但落后 → warn |
| 当前分支是否与交接一致 | 不一致 → warn（detached HEAD 也算不一致） |
| 文件 hash | 文件没了、读不到、或内容变了 → stale |
| 锚点行 | 文本不在这一行了：同文件别处找到 → warn；找不到 → stale |
| 交接文档里的疑似密钥 | 命中 `sk-`、`ghp_`、`AKIA`、JWT、私钥头等 → warn（只输出掩码） |
| 声明的命令（`--run`） | 退出码与 `expect_exit` 不符 → stale |

## 命令与退出码

| 命令 | 作用 |
| --- | --- |
| `handoffcheck init [--files a,b] [--anchor path:line] [--command "npm test"] [--out HANDOFF.md] [--force]` | 从当前仓库状态写一份交接 |
| `handoffcheck check [HANDOFF.md] [--run] [--strict] [--timeout 120] [--json]` | 校验；默认读 `./HANDOFF.md` |
| `handoffcheck help` | 显示帮助 |

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部成立（`--strict` 下连同警告一起要求没有） |
| `1` | 有过期项；或 `--strict` 下有警告 |
| `2` | 用法 / 格式错误：不是 git 仓库、表头缺列、锚点行号不是整数等 |

stdout 只放结果（`--json` 时是纯 JSON），错误只进 stderr，脚本可以直接看退出码。

## init 的默认值

- `--files` 不给：取工作区改动过的文件（tracked diff + untracked）；工作区干净时取最后一次提交改过的文件。
- `--anchor` 不给：在列出的文件里扫 `TODO` / `FIXME` / `XXX` / `HACK`，最多 20 条。
- `--command` 不给：`package.json` 有 `test` 脚本就写一条 `npm test`，`expect_exit` 为 `0`。
- 已存在 `HANDOFF.md` 时拒绝覆盖，要覆盖加 `--force`。
- 交接文档自己不会被记进 Files（否则每次重写都自相矛盾）。

## 在 CI 里用

```yaml
- run: node src/cli.mjs check HANDOFF.md --strict
```

`--strict` 把警告也当失败，适合当门禁。只想挡住「明确过期」就用默认模式。

## demo

`demo/demo.mjs` 会在 `demo/.tmp/` 下建一个真的 git 仓库，演示「交接 → 改代码 → 过期」的全过程，并断言两次 `check` 的退出码：

```bash
node demo/demo.mjs
```

输出是 CLI 的真实 stdout，不是手写的示例。

## 测试

```bash
npm test
```

`node --test`，覆盖解析（表头、转义、坏格式）、各项检查（hash、锚点漂移、密钥掩码）、以及真 git 仓库上的 `init` → `check` 端到端流程。

## 安全边界

- `check --run` 会执行交接文档里写的命令。只对自己写的、或已经审过的 `HANDOFF.md` 用 `--run`。
- 疑似密钥只输出掩码，不会把完整值打出来；但它仍建议你删掉交接里的密钥，而不是依赖这个扫描。
- 不联网、不调用模型、不改仓库内容（`init` 只写你指定的那一个文件）。

## 已知限制

- 只认固定格式。手写的自由文本交接不做猜测解析，宁可报格式错误。
- 文件 hash 按内容算，格式化工具（prettier 等）会触发 stale——这是有意的：内容变了就值得重新确认。
- 锚点只比较「这一行包含这段文本」，不做语义判断。
- 大文件（> 2 MB）和二进制文件：`init` 跳过并在输出里提示，`check` 遇到就报 stale（无法核对），不会静默通过。

## License

MIT（见 [LICENSE](./LICENSE)）。
