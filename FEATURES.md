# 自定义功能注册表

此文件记录了我们在原始仓库基础上添加的所有自定义功能，用于确保在同步upstream时不丢失这些功能。

## 🎯 当前功能列表

### 1. FileSynchronizer .gitignore 支持

- **功能描述**: FileSynchronizer自动读取并应用.gitignore规则
- **涉及文件**:
  - `packages/core/src/sync/synchronizer.ts` (新增loadGitignore方法)
  - `.gitignore` (添加venv/规则)
- **关键代码标识**: `loadGitignore()`, `getIgnorePatterns()`, `getTrackedFiles()`
- **添加时间**: 2025-07-30
- **状态**: ✅ 已实现
- **测试验证**: `FileSynchronizer`正确过滤venv目录和.gitignore规则

### 2. MCP索引状态查询功能

- **功能描述**: 提供get_indexing_status工具查询代码库索引进度
- **涉及文件**:
  - `packages/mcp/src/handlers.ts` (IndexingProgress接口，handleGetIndexingStatus方法)
  - `packages/mcp/src/index.ts` (get_indexing_status工具定义)
- **关键代码标识**: `IndexingProgress`, `handleGetIndexingStatus`, `indexingProgress Map`
- **添加时间**: 2025-07-30
- **状态**: ✅ 已实现
- **测试验证**: 可查询特定或全部代码库的索引状态，显示进度详情

## 🔧 功能保护规则

### 高优先级保护 (🔒)

- FileSynchronizer的.gitignore支持
- MCP索引状态查询功能
- 性能优化和错误处理增强

### 可协商替换 (🔄)

- 代码风格调整
- 非核心工具描述文本

## 📝 变更记录

### 2025-07-30

- 初始创建功能注册表
- 记录FileSynchronizer .gitignore支持功能
- 记录MCP索引状态查询功能
- 在upstream重构后重新实现索引状态功能
