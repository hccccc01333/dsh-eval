# dsh-eval

[English](README.md) | 中文

**面向 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 评测平台。**

[![npm version](https://img.shields.io/npm/v/dsh-eval)](https://www.npmjs.com/package/dsh-eval)
[![license](https://img.shields.io/github/license/hccccc01333/dsh-eval)](LICENSE)

对 headless `dsh` profile 跑 benchmark，把持久化的 session 日志收获成 trace，折叠出自动指标，评分任务成功与工具选择，并把 run 输出为报告或做对比 —— 一份 `benchmark.yaml` 进，一份 JSON run + Markdown 报告出。

> dsh 生态已有可观测与调试工具（`dsh-trace`、`dsh-tps`、`dsh-context-doctor`）。dsh-eval 补的是缺的那一格：**评测平台**。

## 能力

- `dsh eval run benchmark.yaml` —— 每个 case × trial 编排一个 headless `dsh` 子进程
- 从持久化 session 日志收获 trace（模型看到的每个字节都能从日志重建）
- 自动指标：任务成功、工具成功、工具选择准确率、steps、token、延迟、成本、重试、无效工具调用、上下文用量
- 脚本化评分：`expected.tool`（工具选择准确率）与 `expected.check`（任务成功）
- LLM judge：由评审模型给出最终答案得分与幻觉标记
- 子 agent trace 合并：子 session 日志折叠进 trial 指标
- 配对 A/B：同 case 的胜/负/平统计
- 配对推断：对不一致对做精确符号检验，每个均值差给出固定种子 bootstrap 95% 区间
- 并发 trial：`concurrency` / `--concurrency` 让多个 case × trial 同时跑，结果顺序不变
- keyless 回放：有 key 时录一次，CI 里从录制日志复现
- 跨 harness 导入：`dsh eval import codex|claude-code <log> --out run.json`
- `dsh eval report run.json` —— 带每个 trial 评分与合并比率的 Markdown 报告
- `dsh eval compare v1.json v2.json` —— 带符号的 `B - A` 对比表

## 状态

`dsh-eval@0.3.1` · 129 个测试 · `src` 语句/分支/函数/行覆盖率 100% · 类型检查干净 · Linux 与 Windows 双平台 CI。

`0.3.1` 起可安装：`0.3.0` 的 tarball 漏掉了入口 import 的运行时模块，导致每次安装都报 `ERR_MODULE_NOT_FOUND`。详见 [CHANGELOG.md](CHANGELOG.md)。

## 快速开始

直接安装：

```sh
pnpm add dsh-eval
dsh plugin --profile eval add dsh-eval
```

npm 包对齐官方 `@deepseek-ai/*` 发布版（`0.1.0-rc.6` peer），本仓库的 workspace 也解析同一批版本，所以从 clone 构建出来和用户装到的东西一致，不需要链接 harness 检出：

```sh
git clone https://github.com/hccccc01333/dsh-eval.git
cd dsh-eval
pnpm install
pnpm --filter dsh-eval build
pnpm --filter dsh-eval test
```

跑 benchmark 需要一个 `dsh` 启动器；`pnpm test` 不需要（测试套件 keyless，用 fake `dsh` 与录制的 session 日志夹具）：

```sh
dsh plugin --profile eval add dsh-eval
dsh eval run benchmark.yaml --out eval-run.json
dsh eval report eval-run.json
dsh eval compare eval-v1.json eval-v2.json
dsh eval import codex ~/.codex/sessions/.../session.jsonl --out codex-run.json
```

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

每个 trial 在独立的临时工作区、隔离的 `DSH_HOME` 与非交互权限下运行。主 session 日志即该 trial 的 trace；脚本化评分把 `taskSuccess` 与 `toolSelectionAccuracy` 合并为 run 级比率。完整字段参考见 [packages/eval/README.zh.md](packages/eval/README.zh.md)。

## 指标

| 指标 | 来源 |
|---|---|
| 任务成功 | `expected.check` 退出码 0 |
| 工具成功 / 成功率 | session 日志中的 tool result |
| 工具选择准确率 | `expected.tool` 子串匹配 |
| steps / turns | session 日志的 turn 与工具事件 |
| token / 上下文用量 | 互不重叠的 token 桶 + 计费上下文 |
| 延迟 | `llmMs` / `toolMs` / `ttftMs` / `latencyMs` |
| 成本 | 按模型定价表（`pricing`） |
| 重试 | `llm/retry` 事件 |
| 无效工具调用 | 携带内部失败身份的 tool result |
| 最终答案得分 / 幻觉 | `judge` 配置给出的 LLM 评审裁决 |

## CLI

| 命令 | 作用 |
|---|---|
| `dsh eval run benchmark.yaml --out run.json` | 执行 benchmark 并写出 JSON run |
| `dsh eval report run.json` | 把 run 渲染为 Markdown |
| `dsh eval compare base.json candidate.json` | 对比两个 run，给出带符号的 `B - A` 差值 |
| `dsh eval import codex\|claude-code log.jsonl --out run.json` | 把外部 session 日志导入为单 trial run |

`dsh eval run` 还支持 `--trials`、`--concurrency`、`--dsh`、`--profile` 覆盖 benchmark 文档，`dsh eval import` 支持 `--case-id`。

## 路线图

- 按实验组（arm）的配对排行榜
- 报告内多指标的多重比较校正
- run 报告与对比的 Web UI

## 仓库结构

```
packages/eval/    插件 bundle + CLI 应用 + 测试
scripts/          harness-closure.mjs —— 可选的本地 harness workspace 闭包
```

回放（`replay.dir`）需要源码构建的 `dsh`；其余功能用发布版 peer 即可。

## 许可

MIT
