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
| `seed` | `0` | 基础种子：第 n 个 trial 的环境变量为 `DSH_EVAL_SEED=seed+n-1`，该值同时用于报告 bootstrap。harness 需读取该变量才能实现确定性采样。 |
| `cases[].id` | 必填 | 稳定的 case id。 |
| `cases[].prompt` / `cases[].promptFile` | 二选一 | 任务文本，内联或相对 benchmark 文件解析。 |
| `cases[].workspace` | 缺省 | 复制进每个 trial 的工作区树，相对或绝对路径。 |
| `cases[].expected` | 缺省 | 脚本化评分：对记录到的工具调用名匹配 —— `tool`（旧子串）、`tools`（全部列出的子串）、`toolAnyOf`（至少一个）、`toolRegex`（加载时校验）、`toolNot`（都不出现），所有配置同时成立才算命中；`checkArgv`（推荐）、`check`（旧字符串形式，支持引号）或 `checkShell`（显式启用，支持管道/重定向）是 agent 退出后在 trial 工作区运行的命令（退出码 0 = 任务成功）；`answer` 是交给 judge 的金标答案。填了就必须至少给一个，且最多一种 check 模式。check 进程以独立进程组运行，超时整组终止。 |
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

case 配了 `expected.answer` 时，judge 会收到该参考答案，并被要求按事实一致性而非表达流畅度打分。judge 调用失败或返回不可用内容时，裁决带 `judgeError`，run 的 `grading.judgeFailures` 会计数；报告会打印该计数，不再让分数悄悄从均值里消失。

judge 用 case 与合并后的 trace 构造一个严格 JSON 的 prompt。回复可解析时，trial 带上裁决字段（`finalAnswerScore`、`hallucination`、`rationale`）；输出不可用或 chat 调用失败只记为空的裁决字段，绝不记为失败的 trial。配置了 judge 但宿主没有暴露 LLM chat seam 时，run 在启动前就失败。

## 指标

指标折叠直接从 session 日志计算自动指标：`turns`、`steps`、`toolCalls`、`toolResults`、`toolSuccess` 与 `toolSuccessRate`、`invalidToolCalls`（携带内部失败身份的 result）、`retries`（`llm/retry`）、互不重叠的 token 桶与合计、计费上下文 token、`llmMs`/`toolMs`/`ttftMs`/`latencyMs`，以及配置了定价后的 `costUsd`。脚本化评分增加每个 trial 的 `taskSuccess`（check 命令退出码 0）与 `toolSelectionAccuracy`（所有配置的工具约束同时成立），并合并为 run 级比率。`checkArgv` 完全不经过 shell；`checkShell` 仅用于可信 benchmark 文件中需要管道或重定向的场景。卡住的 check 会在 trial 超时时连同整个进程组一起终止，不会拖住整个 run。

trial `DSH_HOME` 下的子 session 日志在折叠前合并进 trial trace，因此委派给子 agent 的工作也计入 steps、token、工具调用、重试与延迟。judge 裁决增加每个 trial 的 `finalAnswerScore` 与 `hallucination`，并合并为 run 级平均分与幻觉率。

## 运行报告

`dsh eval run benchmark.yaml --out run.json` 每次运行写一份 JSON：benchmark 与模型标识、每个 trial 的结果与绝对 trace 路径、聚合指标（计数与耗时为均值，成功率为合并值）、合并后的评分比率。`dsh eval report run.json` 把 run 渲染为 Markdown。trial 工作区与 trace 保留在 run 的 `tempRoot`（私有临时目录）中且不会被删除，run 不再需要时自行清理。

Markdown 报告会为每个评分维度（任务成功、工具选择准确率）追加**可靠性**区块。合并比率无法区分"每个 case 都稳定在 66%"与"两个 case 全过、第三个全挂"；因此区块给出 `pass@1`（trial 级）、`pass@k`（至少一个 trial 成功的 case 比例）、`pass^k`（全部 trial 成功的 case 比例），以及结果不一致的不稳定 case 和按通过率排序的最难 case。报告头部还会给出 trial 覆盖率（完成/总数、未评分、超时数），可靠性区块在"仅已评分"的通过率旁并列 **严格 pass@1**：超时与失败 trial 留在分母里，因此"难题上超时"的模型不会显得比"跑完但答错"的模型更好。这些指标在渲染时从已保存的 trial 现算，旧报告无需重跑就能获得新区块。`dsh eval run` 只要有任何 trial 失败就以非零码退出，而非等到全部失败。

`dsh eval report run.json --brief` 改为输出紧凑的终端摘要：试验覆盖率、每个 trial 的工具/步数/token/成本、任务通过率与 pass@k/pass^k、bootstrap 区间、判官失败数。省略逐 trial 表格，百次 run 也能一屏看完。

`dsh eval dashboard a.json [b.json] --out report.html` 写出独立的 HTML 视图：覆盖率、pass@1/pass@k、延迟 p95 与成本的摘要卡片，以及可靠性、精度、判官/脚本一致性和逐 trial 表格。无外部 CSS、字体或脚本，自动跟随系统亮/暗主题；benchmark id、case id 与错误字符串都做 HTML 转义，agent 产生的错误信息无法向页面注入标记。提供第二个 run 时会追加对比表，数据与 `dsh eval compare` 完全一致，包括带符号的 `B − A` 差值和 Bonferroni 校正后的配对推断行。

完整报告里，可靠性区块之后是**精度**区块：用 run 的 `seed` 对已评分 trial 的 0/1 结果做 bootstrap（默认 2000 次固定种子重采样），给出任务/工具通过率的 95% 百分位区间与样本数 `n=`。只有一个 trial 时只报通过率、不报区间 —— 单个观测无法重采样出不确定性。区块同时给出 trial 延迟的 p50/p95，让三 trial 的冒烟测试看起来就是薄弱证据，而不是一个看似精确的百分比。

**判官 / 脚本一致性**区块把脚本的 `taskSuccess` 与判官的"未检出幻觉"结论配对（仅统计两者都存在的 trial），给出观察一致率与 Cohen's kappa。kappa 扣除了由两边边缘分布带来的偶然一致 —— 否则一个"什么都判通过"的判官，在脚本检查也全部通过时会显得很准。判官输出不可用或没有检查的 trial 会被排除；没有任何配对时该区块不渲染。`--brief` 输出同样包含一行该指标。

## 对比

`dsh eval compare run-v1.json run-v2.json` 把两个 run 渲染成 Markdown 表：benchmark/模型标识、完成的 trial 数、steps、工具/任务/工具选择成功率、两个评分维度的 pass@k 与 pass^k、无效调用、重试、token、成本与延迟，并给出带符号的 `B - A` 差值。当两个 run 完成的 case × trial 键完全一致时，表尾追加配对统计：trial 数、按第一个可用指标（任务成功、工具选择准确率、最终答案得分）的胜/负/平，以及 steps、token、judge 得分的 `B - A` 均值差。每个 run 的 `seed` 既是配对的可追溯出处，也注入到每个 trial 的 `DSH_EVAL_SEED`；是否确定性仍取决于 harness 是否读取该变量。

配对样本量小、差值不服从正态，所以配对区块除了点估计还给出推断：对主指标的不一致对做**精确双侧符号检验**（同分的对按要求剔除），并在每个均值差旁给出**固定种子 bootstrap 区间**。不对差值分布的形状做任何假设，PRNG 种子固定，因此同一对报告重跑 `compare` 输出逐字节一致。符号检验的 p 值与输出的每个区间构成一个推断族，用 **Bonferroni** 在族错误率 `alpha = 0.05` 下一并校正：p 值所在行标注其乘上的族大小，每个区间放宽到 `1 - 0.05/k` 置信度（例如 p 值与三个区间同时存在时为 98.8%）。符号检验仍需要不一致对才能给出结论：全部同分的 run 报 `p = 1`。

`dsh eval compare` 还会追加 **Paired case outcomes**：每个完成的 case x trial 用与符号检验相同的主指标分类，候选胜出排在失败之前，最多显示 20 行。这样显著的 p 值可以直接追溯到造成差异的具体 case。双 run HTML 仪表盘也在 **Changed cases** 下展示相同的不一致案例。

## 判官校准

一致率与 kappa 回答"判官和脚本是否得出相同结论"，校准回答"判官的分数对排序是否真的有用"。`computeCalibration`（渲染在完整报告与 HTML 仪表盘中，`--brief` 输出摘要）给出脚本通过与失败 trial 的判官归一化均分、两者差值，以及等价于 AUC 的排序准确率（并列计半）。它还会列出最多 5 个两种视图不一致的 case，便于直接按实例修正 rubric，而不是只盯着一个聚合数字。分数缺失的 trial 仍可通过幻觉标记参与判断；两者都缺失的 trial 记为未评分，不做猜测。

## CI 质量门禁

`dsh eval gate candidate.json --baseline base.json --max-drop 0.05` 把 run 对比变成构建判定。它先检查完成 trial 数与未评分 trial 数，再检查任务成功率、工具选择准确率、strict pass@1 与判官得分。所有质量指标都归一化到 0..1（判官得分除以对应 run 的 `maxScore`），因此一个容差适用于所有指标。命令输出 PASS/FAIL 表格，任何指标回退超过容差即以 1 退出，可直接作为 CI 必需步骤。

存在配对 trial 时，判定还会列出最多 5 个从通过翻转为失败（或判官分数下降）的 case x trial，case id 会做 markdown 净化；失败的门禁因此能直接指出该查哪里，而不只是一个百分比。基线缺失的指标记为 "baseline ungraded" 并通过；候选 run 缺失的指标则判失败，不会被悄悄跳过。若 benchmark 有意改变 trial 数量，可传 `--allow-incomplete` 跳过覆盖度检查。

## 回放（keyless CI）

带 key 的 run 会把每个 trial 的 session 日志记录在其 `tempRoot` 下。把这些录制好的 trial 目录拷进 `replay.dir`，即可在无凭据的情况下重跑：被启动的 harness 会挂载 `@deepseek-ai/dsh-llm-replay`，从录制下来的 `assistant/chunk` 事件重建每一次模型流。

```yaml
replay:
  dir: ./recorded
```

该目录下每个 trial 一棵树，命名为 `<caseId>-<trial>/`，子日志与其并列：`recorded/fix-tests-001-1/session.jsonl`。缺夹具会让该 trial 失败；`judge` 不能与 `replay` 出现在同一个 run 里。回放插件的 npm 发布版滞后于源码工作区，因此回放需要源码模式的 harness 检出。

## 离线重评分

由于 `judge` 与 `replay` 不能在同一个 run 里共存，可把评审拆成两阶段：

```sh
dsh eval rejudge recorded-run.json --out judged-run.json
```

`rejudge` 从报告记录的 trace 路径与 `caseInputs` 重建判官 prompt，为每个 trial 重新生成裁决，并重新汇总 grading。指标、脚本评分、trial 结果与错误详情保持不变，只有 `judge` 裁决与 `grading` 变化。输入报告不会被覆盖（`--out` 必须不同）。没有 `caseInputs` 的旧报告会收到明确诊断，而不会用空 prompt 悄悄重评。trace 路径必须是 `tempRoot` 内的绝对 `.jsonl` 路径，避免被篡改的报告诱使判官把本地任意文件发给 LLM。

重评时可以指定或替换判官配置 —— 这是回放工作流可用的前提（回放 run 没有保存 judge 配置）：

```sh
dsh eval rejudge recorded-run.json --out judged.json \
  --judge-model deepseek-v4 --judge-provider deepseek \
  --judge-rubric "答案正确且简洁" --judge-max-score 10
```

覆盖配置只需 `--judge-model`，其余默认 `deepseek`、`10` 与无 rubric；实际使用的配置会写入新报告。若判官调用失败，已有的有效裁决会被保留并标注 `judgeError`，不会被一次故障抹掉。

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

- **judge 输出尽力而为但不再静默** —— 失败或无法解析的裁决带 `judgeError` 并计入 `grading.judgeFailures`；judge 调用消耗的模型额度不计入 trial 的计量成本。
- **配对对比按现状配对** —— trial 按 case id 与 trial 序号配对；`seed` 传入每个 trial 的 `DSH_EVAL_SEED` 并作为出处记录，但确定性取决于 harness 是否遵守该变量；按实验组（arm）的排行榜尚未渲染。
- **Bonferroni 偏保守** —— 它在不假设各推断独立的前提下控制族错误率，代价是区间更宽；符号检验仍需要不一致对才能给出结论，全部同分的 run 报 `p = 1`。
- **回放按首次调用顺序绑定** —— 回放插件按首次调用顺序把录制脚本对应到实时 session，因此并发子 agent 的回放是非确定性的。
- **导入的 trace 没有 token 用量** —— Codex 与 Claude Code 日志不记录 provider 用量，导入的 run 报零 token 且无成本。
- **超时只杀直接子进程** —— 超时的 trial 只杀直接 dsh 进程；在 Windows 上它的后代进程可能存活。
- **Windows 启动器命令** —— 启动的子进程不经过 shell，`.cmd`/`.bat` shim 需要直接可执行文件或 `node <path>` 覆盖（`--dsh "node C:/.../apps/cli/lib/bin.js"`）。
- **报告写入非原子** —— run JSON 原地写入，写入中途崩溃可能截断报告。
