# `dsh-eval`

English | [中文](README.md)

基于 headless dsh profile 的 Agent 评测：一份 benchmark YAML 文档、每个 case × trial 一个 headless dsh 子进程、从持久化 session 日志收集 trace、自动指标折叠，以及 JSON/Markdown 运行报告。

该包既是 bundle 也是命令行应用。安装到 profile 后即可运行评测：

```sh
dsh plugin --profile eval add dsh-eval
dsh eval run benchmark.yaml
dsh eval report eval-run.json
dsh eval compare eval-v1.json eval-v2.json
```

`dsh eval` 是 `--profile eval` 的启动器别名；eval profile 由 `dsh-base` 加本 bundle 组成。每个 trial 使用独立的临时工作区、隔离的 `DSH_HOME` 和强制纯 JSONL 持久化与非交互 workspace-write/never-approval 权限的补丁层，以 benchmark 配置的 `dsh` 命令（默认 `dsh`）与 profile（默认 `headless`）运行。收获的主 session 日志即该 trial 的 trace；子 agent 日志暂不包含。

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

字段：`name`/`model` 必填；`profile` 默认 `headless`；`command` 默认 `[dsh]`；`trials` 默认 `1`；`timeoutMs` 默认 `600000`；`seed` 默认 `0`（为未来确定性配对预留）；每个 case 需要 `id` 和 `prompt` 或 `promptFile`（相对 benchmark 文件解析），可选 `workspace`；`expected` 为脚本化评分（`tool` 是匹配工具调用名的子串，`check` 是 agent 退出后在 trial 工作区运行的命令，退出码 0 视为任务成功，二者至少填一个）；`pricing` 以模型 id 为键，缺省模型的 `costUsd` 为 `null`。

| 字段 | 默认 | 含义 |
|---|---|---|
| `name` | 必填 | Benchmark 名称，也是 run 记录的 `benchmark` 字段。 |
| `model` | 必填 | 用于定价查找与运行报告的模型 id。 |
| `profile` | `headless` | 每个 trial 启动的 dsh profile。 |
| `command` | `[dsh]` | dsh 启动器 argv。 |
| `trials` | `1` | 每个 case 的 trial 数。 |
| `timeoutMs` | `600000` | 每个 trial 的超时；到期直接杀掉子进程。 |
| `seed` | `0` | 为未来确定性配对比较预留。 |
| `cases[].id` | 必填 | 稳定 case id。 |
| `cases[].prompt` / `cases[].promptFile` | 二选一 | 任务文本，内联或相对 benchmark 文件。 |
| `cases[].workspace` | 缺省 | 复制进每个 trial 的工作区树，相对或绝对路径。 |
| `pricing` | 缺省 | 以模型 id 为键的每百万 token 美元价；缺省模型 `costUsd` 为 `null`。 |

## 指标

指标折叠直接由 session 日志计算自动指标：`turns`、`steps`、`toolCalls`、`toolResults`、`toolSuccess` 与 `toolSuccessRate`、`invalidToolCalls`（带内部失败身份的 result）、`retries`（`llm/retry`）、互斥 token 桶与合计、计费上下文 token、`llmMs`/`toolMs`/`ttftMs`/`latencyMs`，以及配置定价后的 `costUsd`。脚本化评分增加每个 trial 的 `taskSuccess`（check 命令退出码为 0）与 `toolSelectionAccuracy`（命中预期工具），并合并为 run 级比率。LLM judge 指标（最终答案得分、幻觉）延后。

## 运行报告

`dsh eval run --out run.json` 每次运行写一份 JSON：benchmark 与模型标识、每个 trial 的结果与绝对 trace 路径、聚合指标（计数与耗时取均值、成功率取合并值）与合并评分比率。`dsh eval report run.json` 把 run 渲染为 markdown。trial 工作区与 trace 保留在 `tempRoot`（私有临时目录）中，不再需要时自行删除。

## 对比

`dsh eval compare run-v1.json run-v2.json` 把两个 run 渲染成 markdown 表：benchmark/模型标识、完成 trial 数、steps、工具/任务/工具选择成功率、无效调用、重试、token、成本与延迟，并给出带符号的 `B - A` 差值。对比只读持久化 run；同 seed 配对 trial 仍延后。

## 扩展点

v0.1 只有 runner 一个消费者：`runBenchmark` 接收已加载的 benchmark 并返回 run 记录，report 模块负责持久化与渲染。grader 与 compare 的 seam 留到出现第二个消费者时再定义。

## Model Experience

None, as the benchmark runner reads persisted session logs and spawns headless subprocesses without registering prompt sections, tool schemas, or any other model-facing behavior of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, so no request prefix exists for it to preserve or invalidate.

## Known Limitations and Deferred Work

- **LLM judge 指标延后** —— 最终答案得分与幻觉需要 LLM judge 提供方；脚本化任务成功与工具选择准确率已实现。
- **配对对比延后** —— `dsh eval compare` 按现状对比持久化 run；`seed` 仅校验未用于确定性配对 trial，按 arm 的榜单也未实现。
- **只收获主 session** —— 子 agent 的 `session.<n>.jsonl` 暂不收集，聚合数字不含委派工作。
- **回放模式延后** —— 真实运行需要子 harness 解析的模型凭据；llm-replay 的 keyless CI 接入是后续步骤。
- **超时只杀直接子进程** —— Windows 上被杀的 dsh 的后代进程可能存活。
- **Windows 启动器命令** —— 子进程不经 shell 启动，`.cmd`/`.bat` shim 需要直接可执行文件或 `node <path>` 覆盖（`--dsh "node C:/.../apps/cli/lib/bin.js"`）。
- **报告写入非原子** —— run JSON 原地写入，写入中途崩溃可能截断报告。
