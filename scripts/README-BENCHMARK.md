# 性能基准测试说明

## 目的

这个基准测试脚本用于**实际测量**并发优化带来的性能提升，而不是依赖理论估计。

## 为什么需要实际测试？

理论上的 "3-5x 提升" 可能不准确，因为：

1. **真实瓶颈**：大部分时间可能花在：
   - Embedding API 网络调用（通常 100-500ms/batch）
   - Vector DB 写入速度
   - Embedding 生成时间
   - 而不是文件 I/O

2. **并发限制**：
   - API 速率限制
   - 内存限制
   - 网络带宽

3. **实际收益**：
   - 文件并发只优化了 I/O 部分
   - 如果 I/O 只占总时间的 20%，即使 I/O 快 10 倍，总体也只快 1.2 倍

## 使用方法

### 1. 准备测试项目

选择一个中小型项目（100-500 个文件）作为测试：

```bash
# 可以用项目本身
TEST_PATH=/Users/yuqiang/work/code/code-context/packages/core

# 或者其他项目
TEST_PATH=/path/to/your/test/project
```

### 2. 设置环境变量

```bash
export OPENAI_API_KEY="your-api-key"
export MILVUS_ADDRESS="localhost:19530"
# 可选
export MILVUS_TOKEN="your-token-if-needed"
```

### 3. 运行基准测试

```bash
cd /Users/yuqiang/work/code/code-context

# 使用 ts-node 直接运行
npx ts-node scripts/benchmark-indexing.ts $TEST_PATH

# 或者先编译再运行
pnpm build
node scripts/benchmark-indexing.js $TEST_PATH
```

### 4. 查看结果

脚本会输出：

```
============================================================
SERIAL Mode Results
============================================================
Total Time:        45.23s
Files Processed:   150
Chunks Indexed:    1234
Files/sec:         3.32
Chunks/sec:        27.29
Avg Time/File:     301ms
Memory Used:       256MB
CPU Cores:         8
============================================================

============================================================
CONCURRENT Mode Results
============================================================
Total Time:        32.15s
Files Processed:   150
Chunks Indexed:    1234
Files/sec:         4.67
Chunks/sec:        38.38
Avg Time/File:     214ms
Memory Used:       312MB
CPU Cores:         8
============================================================

============================================================
PERFORMANCE COMPARISON
============================================================

Time Improvement:
  Serial:     45.23s
  Concurrent: 32.15s
  Speedup:    1.41x ✅

Throughput Improvement:
  Files/sec speedup:  1.41x
  Chunks/sec speedup: 1.41x

Memory Overhead:
  Serial:     256MB
  Concurrent: 312MB
  Overhead:   21.9%

============================================================

REALISTIC ASSESSMENT:
✅ Moderate improvement: 1.41x speedup
   Some benefit from concurrent processing

============================================================
```

## 预期结果

### 乐观情况（小文件多，网络快）

- **1.3-1.8x** 提升
- 文件 I/O 占比较大
- 网络和 API 不是瓶颈

### 现实情况（混合项目）

- **1.1-1.4x** 提升
- Embedding API 是主要瓶颈
- 并发文件处理有一定帮助

### 悲观情况（大文件，慢网络）

- **1.0-1.2x** 提升
- 网络和 API 完全是瓶颈
- 文件 I/O 几乎可以忽略

## 瓶颈分析

运行测试后，可以判断真正的瓶颈：

### 如果并发提升不明显（< 1.2x）

**瓶颈不是文件 I/O，而是：**

1. **Embedding API 调用**
   - 解决：实现真正的 API 并发（Phase 2）
   - 预期额外提升：1.5-2x

2. **网络延迟**
   - 解决：使用更快的网络或本地 embedding
   - 预期额外提升：2-3x

3. **Vector DB 写入速度**
   - 解决：批量写入优化
   - 预期额外提升：1.2-1.5x

### 如果并发提升明显（> 1.5x）

**文件 I/O 确实是瓶颈：**

- ✅ 并发优化有效
- ✅ 可以考虑更激进的并发度
- ✅ Worker Threads 可能带来更多提升

## 成本分析

### API 成本

测试会调用 2 次完整索引，成本：

```
假设：150 文件 × 10 chunks × 2 次 = 3000 chunks
OpenAI text-embedding-3-small: ~$0.0001/1K tokens
预估：3000 × 100 tokens ≈ $0.03
```

### 时间成本

```
总时间：2 次索引 + 清理 ≈ 2-5 分钟
```

## 快速测试（可选）

如果不想运行完整测试，可以：

### 1. 只测试文件 I/O 部分

```typescript
// 修改脚本，注释掉 embedding 调用
// 只测量文件读取和分割速度
```

### 2. 使用小型测试集

```bash
# 创建小测试目录
mkdir -p /tmp/test-codebase
cp -r packages/core/src/*.ts /tmp/test-codebase/
# 只测试 20-30 个文件
```

### 3. 查看日志分析

启用详细日志查看各部分耗时：

```bash
export DEBUG=*
npx ts-node scripts/benchmark-indexing.ts $TEST_PATH 2>&1 | tee benchmark.log
```

## 实事求是的评估

基于实际测试经验，合理的预期是：

- **文件并发优化**：1.2-1.5x（不是 3-5x）
- **API 并发优化**（未实现）：1.3-1.8x
- **组合优化**：1.5-2.5x（不是 6-15x）

**真正的大幅提升（5x+）需要**：
- 本地 embedding（去除网络延迟）
- Worker Threads（真正的 CPU 并行）
- 更快的 Vector DB
- 智能缓存（避免重复计算）

---

**结论**：通过实际测试来验证优化效果，而不是依赖理论估计。
