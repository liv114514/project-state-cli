# project-state 可视化数据前端 (Dashboard)

本目录为 `project-state` 命令行工具配套的数据可视化台账前端。采用 **纯静态、零外部依赖、只读** 架构，可直接双击 `index.html` 在浏览器中打开。

---

## 目录结构

```text
dashboard/
├── index.html            # 主仪表盘页面（语义化 HTML5 + 内联 SVG 滤镜）
├── styles.css            # Forensic Ledger（司法级数字台账）设计系统样式
├── app.js                # 前端交互与 SVG 图表渲染逻辑（零依赖原生 ES）
└── data/
    ├── sample-data.js    # 默认合成演示数据（符合 CLI schema-v2 标准）
    ├── live-data.js      # 由 collect_data.py 自动生成的真实本地数据（可选）
    └── live-data.json    # 独立的 JSON 数据包（支持拖拽导入）
```

---

## 使用方式

### 方式 1：直接预览（合成演示数据）
双击打开 `dashboard/index.html`。页面已预装符合 `project-state` Schema v2 规范的合成数据，包含已验证快照、无效快照、差异对比、诊断以及日志回滚状态。

### 方式 2：采集真实项目数据
在目标项目或工作区中运行数据收集脚本：
```bash
python tools/collect_data.py --project "d:/path/to/target/project"
```
运行后将自动生成 `dashboard/data/live-data.js` 与 `live-data.json`。重新刷新 `index.html`，页面顶部将自动切换为 `LIVE` 标识。

### 方式 3：页面拖拽导入
可将 `collect_data.py` 生成的 `live-data.json`，或直接将 CLI 执行 `project-state list --json` 的输出文件拖入页面任意区域，前端将动态解析并展示。

---

## 核心设计风格 (Forensic Ledger)

1. **三态语义模型（Tri-state Semantics）**：
   - 严格区分 **已验证 (ok)**、**有变化/需关注 (warn)** 与 **未知/未比对 (unknown)**。
   - **绝对不将“未知/跳过”渲染为平静的绿色/正常状态**，采用 45° 细斜纹（Hatch Pattern）渲染，保证审计严谨性。
2. **零泄漏隐私展示（Zero-leakage Privacy）**：
   - 环境变量、数据库内容、包版本细节等在 CLI 声明 `values withheld` 的部分，前端统一采用纯色暗码块（Redaction Block）示意。
3. **分层台账与时间线（Layered Matrix & Timeline）**：
   - 覆盖 Git、依赖 (deps)、运行时 (runtime)、配置 (config)、Docker、数据库 (database) 六层矩阵。
   - 完整展示事务恢复与回滚步进器（prepared → published → verified → rolled-back）。
