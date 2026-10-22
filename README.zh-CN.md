# project-state

**记录选定的项目状态、比较变化，并恢复明确支持的一部分工件。**

**English:** [Read the English documentation](README.md).

project-state 是本地 Node.js 命令行工具。它帮助开发者保存选定的项目状态、查看差异，并在通过安全检查时恢复受支持的工件。它不是完整备份或应用健康检查工具，也不会自动重启应用。

## 当前状态与环境要求

当前候选版本为 `1.4.0-rc.11`，尚未发布到 npm。公共契约仍为 revision 21，快照格式仍为 schema v2。需要 Node.js 22 或更高版本及 Git。采集 SQLite 行数据和严格数据库测试需要真实 `sqlite3` CLI。工具没有运行时 npm 依赖，但仍受文件系统和平台行为影响。

## 从这里开始

在源码检出根目录查看命令和本机状态：

```sh
node bin/project-state.js help
node bin/project-state.js doctor
```

日常使用不需要先运行完整测试套件。

## 运行一次性体验

在源码检出根目录运行：

```sh
npm run demo
```

体验脚本会在操作系统临时目录自动创建一个一次性合成 Git 项目，写入虚构 `.env`，保存快照、比较变化、预览并恢复，然后执行 CLI 原样打印的回退命令，并逐字节验证 A → B → A → B。它不会修改当前项目，也不验证应用健康或真实业务数据。失败时会保留带身份标记的演示目录供检查。

演示脚本也包含在本地 tarball 中。安装到独立 prefix 后，可在该包目录运行 `npm run demo`；脚本仍会使用另一个临时项目。CLI 安装路径示例见下文。

## 保存、比较、预览和恢复

以下命令要求当前目录是目标项目根目录。把工具路径替换为源码检出目录或安装 prefix。配置文件必须先被 Git 排除；在写入任何敏感值前先检查。若检查没有显示匹配规则，应先设置并提交忽略规则，再继续。工具不会替你编辑配置。

PowerShell，使用源码检出：

```powershell
$toolRoot = 'C:\path\to\project-state' # 替换为源码检出目录
$cli = Join-Path $toolRoot 'bin\project-state.js'
git check-ignore -- .env
node $cli doctor
node $cli snapshot before-config-change
# 使用日常编辑器修改本地配置。
node $cli compare before-config-change
node $cli restore before-config-change --only config --dry-run
# 检查当前计划后，明确授权写入：
node $cli restore before-config-change --only config --yes
```

Bash，使用源码检出：

```sh
TOOL_ROOT='/path/to/project-state' # 替换为源码检出目录
CLI="$TOOL_ROOT/bin/project-state.js"
git check-ignore -- .env
node "$CLI" doctor
node "$CLI" snapshot before-config-change
# 使用日常编辑器修改本地配置。
node "$CLI" compare before-config-change
node "$CLI" restore before-config-change --only config --dry-run
# 检查当前计划后，明确授权写入：
node "$CLI" restore before-config-change --only config --yes
```

安装本地 tarball 时，将 CLI 路径设为 `tool-prefix/node_modules/project-state-snapshot/bin/project-state.js`（按平台使用路径分隔符）。请把确切 tarball 安装到独立 prefix；当前候选尚未发布到 npm registry。恢复后工具会校验文件字节，但不会重启应用或验证应用健康。如果 CLI 打印了精确回退命令，请在同一项目根目录原样执行，不要手工改写。

## 操作拒绝或中断时

先用 `project-state list` 查看快照，再用 `compare` 和 `restore --dry-run` 检查受支持状态。事务中断时，使用 CLI 显示的 operation ID 执行 `recover <operationId> --inspect`。如果检查拒绝继续或报告状态不明确，请保留锁、日志、安全 pin 和引用的快照数据。不要删除数据库或 sidecar、不要移除锁、不要 reset/stash 用户改动，也不要用 `--force` 绕过拒绝。

## 支持边界和更多信息

- 快照记录选定文件和元数据。部分快照会明确列出跳过层；被记录不代表可恢复。
- Git 恢复要求处于受支持且干净的状态，并完整保护每个覆盖目标。`--force` 不能绕过不确定性，也不会移动分支引用。
- `--only config,deps,runtime` 是受限文件恢复，不会恢复 Git、数据库行、Docker、运行中的服务或整台机器状态。
- 只有显式运行 `snapshot --with-seed` 且存在真实 SQLite CLI 时才采集行数据。完整备份是本机私密明文。恢复只能创建缺失的数据库目标；已存在数据库或 sidecar 会被拒绝。仅 schema 快照不能恢复行数据。SQL 不会执行。
- 哈希用于发现内容变化，不认证快照作者。文件校验成功不等于应用健康。

参见[能力矩阵](docs/CAPABILITY-MATRIX.md)、[公共契约](docs/CONTRACTS.md)、[已知限制](docs/KNOWN-LIMITATIONS.md)和[贡献与测试指南](CONTRIBUTING.md)。
