# `dsh-eval`

[English](README.md) | 中文

基于 headless dsh profile 的 Agent 评测：一份 benchmark YAML 文档，每个 case × trial 一个 headless dsh 子进程，从持久化 session 日志收获 trace，自动折叠指标，并产出 JSON/Markdown 运行报告。

本包同时是一个 bundle 和一个命令行应用。装进 profile 后即可运行评测：

```sh
dsh plugin --profile eval add dsh-eval
dsh eval run benchmark.yaml
dsh eval report eval-run.json
dsh eval compare eval-v1.json eval-v2.json
```

`dsh eval` 是 `--profile eval` 的启动器别名，eval profile 由 `dsh-base` 加本 bundle 组成。每个 trial 以 benchmark 配置的 `dsh` 命令（默认 `dsh`）和配置的 profile（默认 `headless`）启动，带有独立的临时工作区、隔离的 `DSH_HOME`，以及一层强制纯 JSONL 持久化和非交互 workspace-write/never-approval 权限的补丁。收获的主 session 日志即该 trial 的 trace；该 trial `DSH_HOME` 下的子 agent 日志会在指标折叠前合并进来。

trial 之间彼此独立——各自的临时工作区、隔离的 `DSH_HOME`、各自的补丁层——所以 `concurrency` 可以让这么多个 trial 同时跑。无论并发如何交错，run 记录仍按 case、再按 trial 的顺序列出结果；`--concurrency` 可覆盖文档里的值。调高它是用墙钟时间换峰值 CPU、内存与并发的模型额度。

## Benchmark 文档

```yaml
name: skill-regression
model: deepseek-v4
profile: headless
command: [dsh]
trials: 3
timeoutMs: 600000
seed: 42
cases:
  - id: fix-tests-001
    prompt: Fix the failing tests in this workspace.
    workspace: ./fixtures/fix-tests
    expected:
      tool: bash
      check: ./check.sh
pricing:
  deepseek-v4:
    inputUsdPerMTokens: 0.27
    cacheReadUsdPerMTokens: 0.07
    cacheWriteUsdPerMTokens: 0.27
    outputUsdPerMTokens: 1.10
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `name` | 必填 | Benchmark 名称，同时写入 run 记录的 `benchmark` 字段。 |
| `model` | 必填 | 用于定价查找与运行报告的模型 id。 |
| `profile` | `headless` | 每个 trial 启动的 dsh profile。 |
| `command` | `[dsh]` | dsh 启动器 argv。 |
| `trials` | `1` | 每个 case 的 trial 数。 |
| `concurrency` | `1` | 同时在跑的 case × trial 数；`1` 表示严格串行。 |
| `timeoutMs` | `600000` | 每个 trial 的超时；到期杀掉直接子进程。 |
| `seed` | `0` | 为将来的确定性配对比较预留。 |
| `cases[].id` | 必填 | 稳定的 case id。 |
| `cases[].prompt` / `cases[].promptFile` | 二选一 | 任务文本，内联或相对 benchmark 文件解析。 |
| `cases[].workspace` | 缺省 | 复制进每个 trial 的工作区树，相对或绝对路径。 |
| `cases[].expected` | 缺省 | 脚本化评分：`tool` 是对记录到的工具调用名做子串匹配；`check` 是 agent 退出后在 trial 工作区运行的命令（退出码 0 = 任务成功）。填了就必须至少给一个。 |
| `pricing` | 缺省 | 以模型 id 为键的每百万 token 美元价；未配置的模型报 `costUsd: null`。 |

### Judge

`judge` 开启对最终答案与幻觉的 LLM 评审：

```yaml
judge:
  provider: deepseek
  model: deepseek-v4
  rubric: Prefer correct, concise fixes.
  maxScore: 10
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `deepseek` | judge 调用走的 LLM provider 路由。 |
| `model` | benchmark 的 `model` | judge 使用的模型 id。 |
| `rubric` | 缺省 | 追加到评审 prompt 的任务评分标准。 |
| `maxScore` | `10` | 最终答案得分的上限。 |

judge 用 case 与合并后的 trace 构造一个严格 JSON 的 prompt。回复可解析时，trial 带上裁决字段（`finalAnswerScore`、`hallucination`、`rationale`）；输出不可用或 chat 调用失败只记为空的裁决字段，绝不记为失败的 trial。配置了 judge 但宿主没有暴露 LLM chat seam 时，run 在启动前就失败。

## 指标

指标折叠直接从 session 日志计算自动指标：`turns`、`steps`、`toolCalls`、`toolResults`、`toolSuccess` 与 `toolSuccessRate`、`invalidToolCalls`（携带内部失败身份的 result）、`retries`（`llm/retry`）、互不重叠的 token 桶与合计、计费上下文 token、`llmMs`/`toolMs`/`ttftMs`/`latencyMs`，以及配置了定价后的 `costUsd`。脚本化评分增加每个 trial 的 `taskSuccess`（check 命令退出码 0）与 `toolSelectionAccuracy`（命中预期工具），并合并为 run 级比率。

trial `DSH_HOME` 下的子 session 日志在折叠前合并进 trial trace，因此委派给子 agent 的工作也计入 steps、token、工具调用、重试与延迟。judge 裁决增加每个 trial 的 `finalAnswerScore` 与 `hallucination`，并合并为 run 级平均分与幻觉率。

## 运行报告

`dsh eval run --out run.json` 每次运行写一份 JSON：benchmark 与模型标识、每个 trial 的结果与绝对 trace 路径、聚合指标（计数与耗时为均值，成功率为合并值）、合并后的评分比率。`dsh eval report run.json` 把 run 渲染为 Markdown。trial 工作区与 trace 保留在 run 的 `tempRoot`（私有临时目录）中且不会被删除，run 不再需要时自行清理。

## 对比

`dsh eval compare run-v1.json run-v2.json` 把两个 run 渲染成 Markdown 表：benchmark/模型标识、完成的 trial 数、steps、工具/任务/工具选择成功率、无效调用、重试、token、成本与延迟，并给出带符号的 `B - A` 差值。当两个 run 完成的 case × trial 键完全一致时，表尾追加配对统计：trial 数、按第一个可用指标（任务成功、工具选择准确率、最终答案得分）的胜/负/平，以及 steps、token、judge 得分的 `B - A` 均值差。两个 run 的 `seed` 是配对的可追溯出处，不保证模型输出一致。

配对样本量小、差值不服从正态，所以配对区块除了点估计还给出推断：对主指标的不一致对做**精确双侧符号检验**（同分的对按要求剔除），并在每个均值差旁给出**固定种子 bootstrap 95% 区间**。不对差值分布的形状做任何假设，PRNG 种子固定，因此同一对报告重跑 `compare` 输出逐字节一致。这些 p 值应按"单指标、未做多重比较校正"来读：表里同时列三个指标时，单个略低于 0.05 的 p 只是弱证据。

## 回放（keyless CI）

带 key 的 run 会把每个 trial 的 session 日志记录在其 `tempRoot` 下。把这些录制好的 trial 目录拷进 `replay.dir`，即可在无凭据的情况下重跑：被启动的 harness 会挂载 `@deepseek-ai/dsh-llm-replay`，从录制下来的 `assistant/chunk` 事件重建每一次模型流。

```yaml
replay:
  dir: ./recorded
```

该目录下每个 trial 一棵树，命名为 `<caseId>-<trial>/`，子日志与其并列：`recorded/fix-tests-001-1/session.jsonl`。缺夹具会让该 trial 失败；`judge` 不能与 `replay` 出现在同一个 run 里。回放插件的 npm 发布版滞后于源码工作区，因此回放需要源码模式的 harness 检出。

## 导入外部 trace

`dsh eval import codex|claude-code <session.jsonl> --out run.json` 把 Codex 或 Claude Code 的 session 日志导入成一个单 trial 的 run，并折叠出指标：

- 每条 user 消息合成一个 turn（以及一个 step）；
- assistant 文本、工具调用与工具结果映射进 trace 词汇表；
- 两种外部格式都不记录 token 用量，因此 token 与成本指标保持为零。

导入的 run 直接进入同一套 `report`/`compare` 流水线。

## 扩展点

目前只有一个消费者：`runBenchmark` 接收已加载的 benchmark 并返回 run 记录，report 模块负责持久化与渲染。judge 的 chat seam 由宿主注入（一个 dsh-llm 流），测试中用桩替换，因此测试套件保持 keyless。

## Model Experience

无。benchmark runner 只读取持久化的 session 日志并启动 headless 子进程，自身不注册 prompt 段落、工具 schema 或任何面向模型的行为。

#### KV Cache effect

无。本包既不组装也不发送 provider 请求，因此不存在需要保留或失效的请求前缀。

## 已知限制与延后项

- **judge 输出是尽力而为** —— judge chat 失败或回复无法解析时，裁决字段为空；judge 调用消耗的模型额度不计入 trial 的计量成本。
- **配对对比按现状配对** —— trial 按 case id 与 trial 序号配对；`seed` 是记录下来的出处，并不确定性保证模型输出一致，按实验组（arm）的排行榜尚未渲染。
- **配对推断未做多重比较校正** —— 符号检验与 bootstrap 区间都是单指标的，未对一次输出里的多个指标做校正；而且符号检验需要不一致对才能给出结论：全部同分的 run 报 `p = 1`。
- **回放按首次调用顺序绑定** —— 回放插件按首次调用顺序把录制脚本对应到实时 session，因此并发子 agent 的回放是非确定性的。
- **导入的 trace 没有 token 用量** —— Codex 与 Claude Code 日志不记录 provider 用量，导入的 run 报零 token 且无成本。
- **超时只杀直接子进程** —— 超时的 trial 只杀直接 dsh 进程；在 Windows 上它的后代进程可能存活。
- **Windows 启动器命令** —— 启动的子进程不经过 shell，`.cmd`/`.bat` shim 需要直接可执行文件或 `node <path>` 覆盖（`--dsh "node C:/.../apps/cli/lib/bin.js"`）。
- **报告写入非原子** —— run JSON 原地写入，写入中途崩溃可能截断报告。
