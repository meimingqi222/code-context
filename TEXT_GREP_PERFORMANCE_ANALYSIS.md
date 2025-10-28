# text_grep 性能问题分析和解决方案

## 📊 问题规模

**H:\codes\bpt_all 目录统计：**
- **总文件数：91,304 个**（19.14 GB）
- **总目录数：8,453 个**
- **node_modules/dist/build 目录数：634 个**
- **单个 node_modules：86,139 个文件**
- **预估被扫描的无用文件：~5-6 万个**

**文件类型分布：**
```
42,489 .js    (JavaScript)
13,690 .ts    (TypeScript)
11,269 .json  (配置文件)
 4,597 .map   (Source maps - 应被忽略)
 2,324 .gz    (压缩文件 - 应被忽略)
```

## 🐛 核心问题

### 问题 1：node_modules 可能未被正确忽略（已验证可能不是问题）
- `ignore` 库 v5.3.2 已支持 Windows 路径
- 但为保险起见，已添加路径标准化（`\` → `/`）

### 问题 2：同步递归文件收集（最严重！）
```typescript
// text-search.ts 第 177 行
const entries = fs.readdirSync(dirPath, { withFileTypes: true }); // 🔴 同步阻塞
```
**影响：**
- 需要遍历 **8,453 个目录**
- 每次 `readdirSync()` 都阻塞事件循环
- 无法并发处理，效率极低

### 问题 3：低效的二进制文件检测
```typescript
// 每个文件都调用 isBinaryFile()
if (this.isBinaryFile(file)) { // 🔴 对 9 万+ 文件
    continue;
}
```
**影响：**
- **每个文件 3 次系统调用**：open + read(512 bytes) + close
- **9 万文件 = 27 万次系统调用**
- 应该在收集阶段就通过扩展名过滤

### 问题 4：批处理设置不合理
```typescript
const batchSize = 50;  // 🔴 太小！
const concurrency = Math.min(4, ...); // 🔴 太保守！
```
**影响：**
- 9 万文件 ÷ 50 = **1,826 个批次**
- 并发度只有 4，无法充分利用 I/O 并行

### 问题 5：缺少扩展名预过滤
**.map/.gz/.lock 等文件应在目录遍历时就排除：**
- 4,597 个 .map 文件（通常每个 > 100KB）
- 2,324 个 .gz 文件
- 大量 package-lock.json 等锁文件

## ✅ 解决方案

### 已实施的修复

#### 1. 路径标准化（防御性修复）
```typescript
// text-search.ts 和 text-search-optimized.ts
const normalizedPath = relativePath.replace(/\\/g, '/');
if (this.ignoreFilter && this.ignoreFilter.ignores(normalizedPath)) {
    continue;
}
```

#### 2. 创建优化版本（text-search-optimized.ts）

**核心优化：**

##### a) 异步并发目录遍历
```typescript
// 使用 fs.readdir (异步) 替代 fs.readdirSync (同步)
const entries = await fs.readdir(dirPath, { withFileTypes: true });

// 批量并发处理目录
const concurrency = Math.max(8, os.cpus().length);
const batchResults = await Promise.all(
    batch.map(dir => this.processDirectory(dir, basePath, options))
);
```
**预期提升：10-50x**

##### b) 扩展名预过滤
```typescript
const BINARY_EXTENSIONS = new Set([
    '.exe', '.dll', '.so', '.map', '.gz', '.lock',
    '.jpg', '.png', '.pdf', '.zip', '.wasm', ...
]);

// 在目录遍历时就跳过
const ext = path.extname(entry.name).toLowerCase();
if (this.BINARY_EXTENSIONS.has(ext)) {
    continue;
}
```
**预计减少扫描：~7,000 个文件（.map + .gz + 其他）**

##### c) 提高并发度和批次大小
```typescript
// 自适应批次大小
const batchSize = totalFiles > 10000 ? 200 : totalFiles > 1000 ? 100 : 50;
const concurrency = Math.max(8, os.cpus().length * 2);
```

##### d) 简化二进制检测
```typescript
// 读取文件后直接检查空字节
const content = await fs.readFile(file, 'utf-8');
if (content.includes('\0')) {
    continue;
}
```
**减少系统调用：从 3 次 → 1 次**

##### e) 进度报告
```typescript
if (i % (batchSize * 10) === 0) {
    console.log(`Progress: ${progress}% (${i}/${files.length} files)`);
}
```

## 📈 预期性能提升

### 优化前（当前 text-search.ts）
- **文件收集：** 30-60 秒（同步遍历 8,453 个目录）
- **文件扫描：** 20-40 秒（9 万文件 × 3 次系统调用）
- **总耗时：** 50-100 秒

### 优化后（text-search-optimized.ts）
- **文件收集：** 2-5 秒（异步并发）
- **文件扫描：** 5-10 秒（预过滤 + 并发）
- **总耗时：** 7-15 秒

**预期提升：5-10倍**

## 🚀 优化已应用

所有优化已直接集成到 `text-search.ts` 中，无需额外配置。

**修改内容：**
- ✅ 异步并发文件收集
- ✅ 扩展名预过滤（.map, .gz, .lock 等）
- ✅ 提高并发度（8+ 并发）
- ✅ 自适应批次大小
- ✅ 简化二进制检测
- ✅ Windows 路径标准化
- ✅ 进度报告

## 🧪 验证建议

### 1. 添加 .warpindexingignore 文件
在 `H:\codes\bpt_all\` 创建：
```
node_modules/
dist/
build/
out/
*.map
*.min.js
*.gz
package-lock.json
yarn.lock
pnpm-lock.yaml
```

### 2. 测试命令
```bash
# 测试当前版本速度
time text_grep "import.*React" H:\codes\bpt_all

# 启用优化后再次测试
time text_grep "import.*React" H:\codes\bpt_all
```

### 3. 验证忽略模式生效
```bash
# 应该不返回 node_modules 中的结果
text_grep "console.log" H:\codes\bpt_all | grep node_modules
```

## 🎯 下一步行动

1. ✅ **已完成：** 路径标准化修复
2. ✅ **已完成：** 所有优化直接集成到 text-search.ts
3. ✅ **已完成：** 添加扩展名预过滤
4. ✅ **已完成：** 创建 .warpindexingignore 文件
5. ⏳ **待测试：** 在 H:\codes\bpt_all 验证性能提升

## 💡 额外建议

### 为大型代码库添加警告
```typescript
if (filesCount > 50000) {
    console.warn('[TEXT-SEARCH] Warning: Large codebase detected.');
    console.warn('[TEXT-SEARCH] Consider adding .warpindexingignore file.');
}
```

### 添加超时保护
```typescript
const timeout = options.timeout || 60000; // 60 秒超时
const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Search timeout')), timeout)
);
```

### 支持增量搜索
```typescript
// 找到足够结果后立即返回
if (matches.length >= maxResults) {
    console.log('[TEXT-SEARCH] Reached maxResults, stopping early');
    break;
}
```
