# 自定义功能恢复指南

当upstream同步导致自定义功能丢失时，使用本指南快速恢复功能。

## 🚨 紧急恢复步骤

### 1. 评估损失
```bash
# 运行功能验证脚本
./scripts/validate_features.sh

# 检查备份分支
git log --oneline backup-sync-YYYYMMDD-HHMMSS -n 5
```

### 2. 恢复策略选择

#### 选项A: 完全回滚（最安全）
```bash
# 回滚到合并前状态
BACKUP_BRANCH="backup-sync-YYYYMMDD-HHMMSS"
git reset --hard $BACKUP_BRANCH
git branch -d $BACKUP_BRANCH
```

#### 选项B: 选择性恢复（推荐）
```bash
# 从备份分支恢复特定文件
BACKUP_BRANCH="backup-sync-YYYYMMDD-HHMMSS"

# 恢复FileSynchronizer功能
git checkout $BACKUP_BRANCH -- packages/core/src/sync/synchronizer.ts

# 恢复MCP索引状态功能  
git checkout $BACKUP_BRANCH -- packages/mcp/src/handlers.ts
git checkout $BACKUP_BRANCH -- packages/mcp/src/index.ts

# 恢复.gitignore规则
git checkout $BACKUP_BRANCH -- .gitignore
```

## 🔧 具体功能恢复

### FileSynchronizer .gitignore支持

如果`loadGitignore`方法丢失，添加以下代码到`packages/core/src/sync/synchronizer.ts`：

```typescript
private async loadGitignore() {
    const gitignorePath = path.join(this.rootDir, '.gitignore');
    try {
        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        const gitignorePatterns = gitignoreContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
        this.ignorePatterns = [...new Set([...this.ignorePatterns, ...gitignorePatterns])];
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            console.warn(`Error reading .gitignore file: ${error.message}`);
        }
    }
}

public getIgnorePatterns(): string[] {
    return [...this.ignorePatterns];
}

public getTrackedFiles(): string[] {
    return Array.from(this.fileHashes.keys());
}
```

在`initialize()`方法中调用：
```typescript
public async initialize() {
    console.log(`Initializing file synchronizer for ${this.rootDir}`);
    await this.loadGitignore(); // 添加这行
    await this.loadSnapshot();
    this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
    console.log(`File synchronizer initialized. Loaded ${this.fileHashes.size} file hashes.`);
}
```

### MCP索引状态查询功能

#### 1. 添加接口到`packages/mcp/src/handlers.ts`：
```typescript
interface IndexingProgress {
    path: string;
    phase: string;
    current: number;
    total: number;
    percentage: number;
    startTime: number;
    lastUpdated: number;
}
```

#### 2. 添加进度跟踪属性：
```typescript
export class ToolHandlers {
    // ... 其他属性
    private indexingProgress: Map<string, IndexingProgress> = new Map();
}
```

#### 3. 添加处理方法：
```typescript
public async handleGetIndexingStatus(args: any) {
    const { path: codebasePath } = args;

    try {
        if (codebasePath) {
            // 查询特定代码库状态的逻辑
            const absolutePath = ensureAbsolutePath(codebasePath);
            // ... 详细实现见原文件
        } else {
            // 查询所有代码库状态的逻辑
            // ... 详细实现见原文件
        }
    } catch (error: any) {
        return {
            content: [{
                type: "text",
                text: `Error getting indexing status: ${error.message || error}`
            }],
            isError: true
        };
    }
}
```

#### 4. 在`packages/mcp/src/index.ts`中注册工具：
```typescript
// 在tools数组中添加
{
    name: "get_indexing_status",
    description: "Get the current indexing status for a specific codebase or all codebases.",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Optional ABSOLUTE path to check status for"
            }
        },
        required: []
    }
}

// 在switch语句中添加case
case "get_indexing_status":
    return await this.toolHandlers.handleGetIndexingStatus(args);
```

## 🧪 验证恢复结果

恢复完成后，运行验证：
```bash
# 构建项目
npm run build

# 验证功能
./scripts/validate_features.sh

# 提交恢复的更改
git add .
git commit -m "fix: 恢复upstream同步中丢失的自定义功能"
```

## 📝 预防措施

1. **定期更新FEATURES.md** - 记录新增功能
2. **使用功能分支** - 为重要功能创建专门分支
3. **自动化测试** - 为关键功能编写测试
4. **文档化实现** - 详细记录功能实现细节

## 🆘 求助渠道

如果遇到无法解决的问题：
1. 检查备份分支：`git log backup-sync-*`
2. 对比差异：`git diff backup-branch HEAD -- [file]`  
3. 查看提交历史：`git log --oneline --grep="feat"`
4. 参考FEATURES.md中的实现说明
