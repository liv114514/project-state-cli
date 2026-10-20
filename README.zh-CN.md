# project-state

**记录选定的本地项目状态、比较变化，并恢复有明确边界的一部分。**

`project-state` 是本地 Node.js 命令行工具。快照记录选定文件和元数据；它不是完整机器备份、应用健康检查或通用工作区恢复系统。

## 环境要求

- Node.js 22 或更高版本。
- Git：用于采集 Git 状态及支持范围内的 Git 恢复。
- SQLite 采集和严格数据库测试需要真实 `sqlite3` CLI。
- 工具没有运行时 npm 依赖，但仍依赖 Git、SQLite、文件系统行为和平台支持。

本仓库从私有本地候选 `1.4.0-rc.8` 整理而来。该版本尚未发布到 npm，也不是正式发布。

## 从源码运行

```sh
node bin/project-state.js help
npm run check:version
REQUIRE_SQLITE_TESTS=1 npm test
```

PowerShell 严格测试：

```powershell
$env:REQUIRE_SQLITE_TESTS = '1'
npm test
Remove-Item Env:REQUIRE_SQLITE_TESTS
```

严格模式要求当前进程 `PATH` 中存在真实 `sqlite3`；缺失时数据库测试会失败，不会静默跳过。

## 安装确切的本地 tarball

此预发布版本尚不存在于 npm registry。可在源码检出目录生成本地 tarball，并安装到独立 prefix：

```sh
npm pack
npm install --prefix ./tool-prefix --ignore-scripts --no-audit --no-fund ./project-state-snapshot-1.4.0-rc.8.tgz
node ./tool-prefix/node_modules/project-state-snapshot/bin/project-state.js help
```

如果不希望更改受保护项目文件，请将 prefix 放在项目之外。不要对尚未发布的版本使用 registry 安装命令。

## 一次性配置示例

使用临时 Git 项目和明确虚构的值。先提交忽略规则，再创建本地配置：

```sh
mkdir project-state-demo && cd project-state-demo
git init
git config user.name Demo
git config user.email demo@example.invalid
printf '.env\n.project-state/\n' > .gitignore
git add .gitignore && git commit -m "Add local-state ignore rules"
printf 'APP_MODE=example-only\n' > .env
node /path/to/project-state/bin/project-state.js snapshot demo-before
printf 'APP_MODE=changed-example-only\n' > .env
node /path/to/project-state/bin/project-state.js compare demo-before
node /path/to/project-state/bin/project-state.js restore demo-before --only config --dry-run
node /path/to/project-state/bin/project-state.js restore demo-before --only config --yes
```

示例值是合成数据，不会提交。私密工件以本机明文保存在 `.project-state/secrets/`；请保护整个 `.project-state` 目录。恢复后应自行检查文件和应用。工具不会重启应用。若 CLI 打印回退命令，应在同一项目根目录原样复制执行；回退范围有限，遇到无关改动时会拒绝。

## 支持边界

- 恢复只接受通过校验的 snapshot schema v2 工件。schema v1 仅用于诊断，未知未来格式会被拒绝。
- Git 恢复限于受支持的普通仓库、干净的 index/工作区，以及每个覆盖目标均有完整保护的情况。未提交源码、暂存改动和 untracked 文件不是通用备份对象。`--force` 不能绕过不安全或不确定状态。工具不会移动分支引用。
- `--only config,deps,runtime` 是受限文件层恢复，不切换 Git，也不恢复数据库或 Docker 状态。
- 只有显式使用 `snapshot --with-seed` 且有真实 SQLite CLI 时，才采集数据库行数据。完整备份属于私密数据。恢复只能创建缺失目标；已有数据库或 sidecar 会被拒绝。schema-only 不恢复行数据。SQL 文本只记录、绝不执行。
- Docker 仅记录观察结果。工具观察依赖，但不会安装或切换依赖，不启动应用，也不恢复容器、服务、卷或机器状态。
- 私密存储是本机明文。哈希用于发现变化，不认证快照作者。

参见[能力矩阵](docs/CAPABILITY-MATRIX.md)、[契约](docs/CONTRACTS.md)和[已知限制](docs/KNOWN-LIMITATIONS.md)。
