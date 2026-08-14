# dsh-eval（独立仓库）

独立开发目录：Agent Evaluation Platform 插件 `dsh-eval`，与
deepseek-harness 主仓的 WIP 隔离。

结构：

- `packages/eval/` —— 插件本体（bundle + CLI app）。
- `harness/` —— 指向本地 deepseek-harness 检出的 junction/symlink；pnpm
  workspace 通过它解析 `@deepseek-ai/*` 源码包（0.1.0-rc.5）；npm 发布版则对齐
  官方 `0.1.0-rc.6` peer 依赖，可直接安装。

快速开始（npm 直装）：

```sh
pnpm add dsh-eval
dsh plugin --profile eval add dsh-eval
```

源码流程：

```sh
git clone https://github.com/hccccc01333/dsh-eval.git
cd dsh-eval
New-Item -ItemType Junction -Path harness -Target D:\path\to\deepseek-harness
pnpm install
```

当前能力（v0.2）：

- `dsh eval run benchmark.yaml` —— benchmark 编排 + 自动指标 + 脚本化评分
  （`expected.tool` 工具选择准确率、`expected.check` 任务成功）。
- `dsh eval report run.json` —— markdown 报告，含评分列与聚合比率。
- `dsh eval compare run-v1.json run-v2.json` —— 双 run 对比表，带 `B - A` 差值。
- LLM judge（最终答案得分、幻觉）与同 seed 配对 trial 仍在规划中。

常用命令（在 `D:\dsh-eval` 下）：

```sh
pnpm install
pnpm --filter dsh-eval test
pnpm --filter dsh-eval run typecheck
pnpm --filter dsh-eval build
```
