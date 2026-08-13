# dsh-eval (standalone)

独立开发目录：Agent Evaluation Platform 插件 `@deepseek-ai/dsh-eval`，与
deepseek-harness 主仓的 WIP 隔离。

结构：

- `packages/eval/` —— 插件本体（bundle + CLI app）。
- `harness/` —— 指向 `D:\deepseek-harness` 的 junction；pnpm workspace 通过它
  解析 `@deepseek-ai/*` 源码包（0.1.0-rc.5），避免使用 npm 上过旧的 rc.1 版本。

当前能力（v0.2）：

- `dsh eval run benchmark.yaml` —— benchmark 编排 + 自动指标 + 脚本化评分
  （`expected.tool` 工具选择准确率、`expected.check` 任务成功）。
- `dsh eval report run.json` —— markdown 报告，含评分列与聚合比率。
- `dsh eval compare run-v1.json run-v2.json` —— 双 run 对比表，带 `B - A` 差值。
- LLM judge（最终答案得分、幻觉）与同 seed 配对 trial 仍在规划中。

常用命令（在 `D:\dsh-eval` 下）：

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-eval test
pnpm --filter @deepseek-ai/dsh-eval run typecheck
```
