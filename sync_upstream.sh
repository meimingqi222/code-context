#!/bin/bash

# Fork同步脚本 - 同步原始仓库的更新并保留自己的修改
# 使用方法: ./sync_upstream.sh [--auto] [--feature-check]

set -e

# 配置选项
AUTO_MODE=false
FEATURE_CHECK=true
FEATURE_FILE="FEATURES.md"

# 解析命令行参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --auto)
            AUTO_MODE=true
            shift
            ;;
        --no-feature-check)
            FEATURE_CHECK=false
            shift
            ;;
        -h|--help)
            echo "使用方法: $0 [选项]"
            echo "选项:"
            echo "  --auto              自动模式，跳过交互确认"
            echo "  --no-feature-check  跳过功能保护检查"
            echo "  -h, --help          显示帮助信息"
            exit 0
            ;;
        *)
            echo "未知选项: $1"
            exit 1
            ;;
    esac
done

echo "🔄 开始同步upstream仓库更新..."
echo "📋 自动模式: $AUTO_MODE"
echo "🛡️  功能保护检查: $FEATURE_CHECK"

# 0. 功能保护预检查
if [ "$FEATURE_CHECK" = true ] && [ -f "$FEATURE_FILE" ]; then
    echo "\n🛡️  执行功能保护检查..."
    
    # 检查关键功能文件是否存在
    echo "📁 检查关键功能文件:"
    
    # FileSynchronizer .gitignore 支持
    if grep -q "loadGitignore" packages/core/src/sync/synchronizer.ts 2>/dev/null; then
        echo "  ✅ FileSynchronizer .gitignore支持"
    else
        echo "  ❌ FileSynchronizer .gitignore支持 - 缺失!"
    fi
    
    # MCP索引状态查询功能
    if grep -q "handleGetIndexingStatus" packages/mcp/src/handlers.ts 2>/dev/null; then
        echo "  ✅ MCP索引状态查询功能"
    else
        echo "  ❌ MCP索引状态查询功能 - 缺失!"
    fi
    
    if grep -q "get_indexing_status" packages/mcp/src/index.ts 2>/dev/null; then
        echo "  ✅ MCP索引状态工具注册"
    else
        echo "  ❌ MCP索引状态工具注册 - 缺失!"
    fi
    
    echo "\n💡 同步后将验证这些功能是否完整"
fi

# 1. 检查当前状态
echo "\n📊 检查当前状态..."
if ! git diff-index --quiet HEAD --; then
    echo "⚠️  检测到未提交的更改，请先提交或暂存你的更改"
    git status
    exit 1
fi

# 2. 获取当前分支
CURRENT_BRANCH=$(git branch --show-current)
echo "📍 当前分支: $CURRENT_BRANCH"

# 3. 创建备份分支
BACKUP_BRANCH="backup-sync-$(date +%Y%m%d-%H%M%S)"
echo "💾 创建备份分支: $BACKUP_BRANCH"
git branch $BACKUP_BRANCH

# 4. 获取upstream最新更新
echo "📥 获取upstream更新..."
git fetch upstream

# 5. 检查是否有新的更新
BEHIND_COUNT=$(git rev-list --count HEAD..upstream/master)
if [ "$BEHIND_COUNT" -eq 0 ]; then
    echo "✅ 你的fork已经是最新的！"
    git branch -d $BACKUP_BRANCH
    exit 0
fi

echo "📈 发现 $BEHIND_COUNT 个新提交需要同步"

# 6. 显示即将合并的更改
echo "📋 即将合并的更改:"
git --no-pager log --oneline HEAD..upstream/master

echo ""
read -p "🤔 是否继续合并这些更改? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ 取消同步"
    git branch -d $BACKUP_BRANCH
    exit 0
fi

# 7. 执行合并
echo "🔀 执行合并..."
if git merge upstream/master --no-edit; then
    echo "✅ 合并成功！"
    
        # 8. 构建项目验证
        echo "🔨 构建项目验证..."
        if npm run build; then
            echo "✅ 构建成功！"
            
            # 9. 功能验证
            if [ "$FEATURE_CHECK" = true ]; then
                echo "\n🛡️  执行功能完整性验证..."
                if [ -f "scripts/validate_features.sh" ]; then
                    if ./scripts/validate_features.sh; then
                        echo "✅ 所有自定义功能验证通过！"
                    else
                        echo "⚠️  功能验证失败！"
                        echo "🔧 某些自定义功能可能在合并中丢失或损坏"
                        
                        if [ "$AUTO_MODE" = false ]; then
                            echo "\n💡 你可以选择:"
                            echo "  1. 继续推送 (风险: 功能可能不完整)"
                            echo "  2. 中止同步，手动修复功能"
                            echo "  3. 回滚到备份分支"
                            read -p "请选择 (1/2/3): " -n 1 -r
                            echo
                            
                            case $REPLY in
                                1)
                                    echo "⚠️  用户选择继续推送，尽管功能验证失败"
                                    ;;
                                2)
                                    echo "🛠️  用户选择手动修复功能"
                                    echo "💾 备份分支可用: $BACKUP_BRANCH"
                                    echo "🔧 请参考 FEATURES.md 重新实现缺失的功能"
                                    exit 1
                                    ;;
                                3)
                                    echo "🔄 回滚到备份分支..."
                                    git reset --hard $BACKUP_BRANCH
                                    git branch -d $BACKUP_BRANCH
                                    echo "✅ 已回滚，同步取消"
                                    exit 0
                                    ;;
                                *)
                                    echo "❌ 无效选择，中止同步"
                                    exit 1
                                    ;;
                            esac
                        else
                            echo "🤖 自动模式：尽管功能验证失败，仍继续推送"
                        fi
                    fi
                else
                    echo "⚠️  找不到功能验证脚本，跳过验证"
                fi
            fi
            
            # 10. 推送到origin
            echo "\n📤 推送更新到你的fork..."
            git push origin $CURRENT_BRANCH
            
            echo "🎉 同步完成！"
            echo "💾 备份分支: $BACKUP_BRANCH (如果一切正常，可以删除它)"
            echo "🗑️  删除备份: git branch -d $BACKUP_BRANCH"
            
            if [ "$FEATURE_CHECK" = true ]; then
                echo "\n📋 建议: 运行 ./scripts/validate_features.sh 再次验证功能"
            fi
        else
            echo "❌ 构建失败，可能存在兼容性问题"
            echo "🔧 请检查并修复构建错误"
            echo "💾 可以使用备份分支回滚: git reset --hard $BACKUP_BRANCH"
        fi
else
    echo "💥 合并冲突！请手动解决冲突"
    echo "🛠️  解决冲突后运行: git add . && git commit"
    echo "💾 如需回滚: git merge --abort && git reset --hard $BACKUP_BRANCH"
fi
