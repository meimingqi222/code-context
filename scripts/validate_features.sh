#!/bin/bash

# 功能验证脚本 - 验证自定义功能是否完整
# 使用方法: ./scripts/validate_features.sh

set -e

FEATURE_FILE="FEATURES.md"
VALIDATION_PASSED=true

echo "🔍 开始验证自定义功能..."

# 确保在项目根目录
if [ ! -f "$FEATURE_FILE" ]; then
    echo "❌ 错误: 找不到 $FEATURE_FILE 文件"
    echo "请在项目根目录运行此脚本"
    exit 1
fi

echo "\n📋 根据 $FEATURE_FILE 验证功能..."

validate_feature() {
    local feature_name="$1"
    local check_command="$2"
    local description="$3"
    
    echo -n "🔎 检查 $feature_name ... "
    
    if eval "$check_command"; then
        echo "✅ 通过"
    else
        echo "❌ 失败"
        echo "   描述: $description"
        VALIDATION_PASSED=false
    fi
}

# 1. FileSynchronizer .gitignore 支持
echo "\n📁 FileSynchronizer .gitignore 支持"
validate_feature "loadGitignore方法" \
    "grep -q 'loadGitignore' packages/core/src/sync/synchronizer.ts" \
    "FileSynchronizer应该包含loadGitignore方法"

validate_feature "getIgnorePatterns方法" \
    "grep -q 'getIgnorePatterns' packages/core/src/sync/synchronizer.ts" \
    "FileSynchronizer应该包含getIgnorePatterns调试方法"

validate_feature "getTrackedFiles方法" \
    "grep -q 'getTrackedFiles' packages/core/src/sync/synchronizer.ts" \
    "FileSynchronizer应该包含getTrackedFiles调试方法"

validate_feature "venv规则在.gitignore" \
    "grep -q 'venv/' .gitignore" \
    ".gitignore应该包含venv/规则"

# 2. MCP索引状态查询功能
echo "\n🔧 MCP索引状态查询功能"
validate_feature "IndexingProgress接口" \
    "grep -q 'interface IndexingProgress' packages/mcp/src/handlers.ts" \
    "handlers.ts应该包含IndexingProgress接口定义"

validate_feature "handleGetIndexingStatus方法" \
    "grep -q 'handleGetIndexingStatus' packages/mcp/src/handlers.ts" \
    "handlers.ts应该包含handleGetIndexingStatus方法"

validate_feature "indexingProgress Map" \
    "grep -q 'indexingProgress.*Map' packages/mcp/src/handlers.ts" \
    "handlers.ts应该包含indexingProgress Map用于进度跟踪"

validate_feature "get_indexing_status工具定义" \
    "grep -q 'get_indexing_status' packages/mcp/src/index.ts" \
    "index.ts应该包含get_indexing_status工具定义"

validate_feature "get_indexing_status处理case" \
    "grep -A5 -B5 'case.*get_indexing_status' packages/mcp/src/index.ts | grep -q 'handleGetIndexingStatus'" \
    "index.ts应该包含get_indexing_status的处理case"

# 3. 功能性验证（如果可能）
echo "\n⚙️  功能性验证"

# 检查项目是否能够构建
validate_feature "项目构建" \
    "npm run build > /dev/null 2>&1" \
    "项目应该能够成功构建"

# 简单的FileSynchronizer功能测试
if [ -f "packages/core/dist/sync/synchronizer.js" ]; then
    validate_feature "FileSynchronizer功能" \
        "node -e \"
        const { FileSynchronizer } = require('./packages/core/dist/sync/synchronizer');
        const sync = new FileSynchronizer('.', [], ['.js']);
        sync.initialize().then(() => {
            const patterns = sync.getIgnorePatterns();
            if (patterns.includes('venv/')) {
                console.log('SUCCESS');
                process.exit(0);
            } else {
                process.exit(1);
            }
        }).catch(() => process.exit(1));
        \" 2>/dev/null | grep -q 'SUCCESS'" \
        "FileSynchronizer应该能够加载.gitignore规则"
fi

# 结果汇总
echo "\n📊 验证结果汇总"
if [ "$VALIDATION_PASSED" = true ]; then
    echo "🎉 所有自定义功能验证通过！"
    echo "✅ 你的fork完整保留了所有自定义功能"
    exit 0
else
    echo "⚠️  发现功能缺失或问题！"
    echo "🔧 请检查上述失败的验证项并修复"
    echo "💡 你可能需要重新实现某些功能或解决合并冲突"
    exit 1
fi
