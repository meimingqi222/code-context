import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { CodeContext, COLLECTION_LIMIT_MESSAGE } from "@zilliz/code-context-core";
import { SharedStateManager } from "./shared-state.js";
import { SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "./utils.js";

interface IndexingProgress {
    path: string;
    phase: string;
    current: number;
    total: number;
    percentage: number;
    startTime: number;
    lastUpdated: number;
    status: 'preparing' | 'indexing' | 'completed' | 'error' | 'cancelled';
    error?: string;
    stats?: {
        indexedFiles: number;
        totalChunks: number;
    };
}

/**
 * 混合模式的 MCP 工具处理器
 * - 如果检测到 VSCode 插件的共享状态，优先使用共享状态的索引信息
 * - 如果没有检测到 VSCode 插件，则回退到独立的 MCP 索引管理
 * 这样既保持了 MCP 的独立性，又能与 VSCode 插件协作
 */
export class HybridToolHandlers {
    private codeContext: CodeContext;
    private sharedStateManager: SharedStateManager;
    private snapshotManager: SnapshotManager;
    private activeIndexing = new Map<string, IndexingProgress>();
    private currentWorkspace: string;

    constructor(codeContext: CodeContext, sharedStateManager: SharedStateManager, snapshotManager: SnapshotManager) {
        this.codeContext = codeContext;
        this.sharedStateManager = sharedStateManager;
        this.snapshotManager = snapshotManager;
        this.currentWorkspace = process.cwd();
        console.log(`[HYBRID-HANDLER] Current workspace: ${this.currentWorkspace}`);
        
        // 初始化检查模式
        this.detectWorkingMode();
    }

    /**
     * 检测工作模式：VSCode 插件模式 或 独立模式
     */
    private detectWorkingMode(): void {
        const sharedState = this.sharedStateManager.getState();
        const hasVSCodeData = sharedState.indexes.length > 0 || sharedState.activeIndexing.length > 0 || sharedState.lastUpdated > 0;
        
        if (hasVSCodeData) {
            console.log('[HYBRID-HANDLER] 🔗 VSCode extension detected, using shared indexing mode');
        } else {
            console.log('[HYBRID-HANDLER] 🔧 No VSCode extension detected, using independent MCP mode');
        }
    }

    /**
     * 智能检查索引状态：优先使用 VSCode 插件状态，回退到 MCP 状态
     */
    private checkIndexingStatus(targetPath: string): { 
        isIndexed: boolean; 
        isIndexing: boolean; 
        indexedPath?: string; 
        indexingPath?: string;
        source: 'vscode' | 'mcp';
    } {
        // 首先尝试从 VSCode 插件获取状态
        const vscodeStatus = this.sharedStateManager.checkIndexingStatus(targetPath);
        if (vscodeStatus.isIndexed || vscodeStatus.isIndexing) {
            console.log(`[HYBRID-HANDLER] 🔗 Using VSCode extension index status for: ${targetPath}`);
            return {
                ...vscodeStatus,
                source: 'vscode'
            };
        }

        // 回退到 MCP 本地状态
        const indexed = this.snapshotManager.getIndexedCodebases();
        const indexing = this.snapshotManager.getIndexingCodebases();
        
        // 检查精确匹配
        const normalizedTarget = path.resolve(targetPath);
        
        for (const indexedPath of indexed) {
            const normalizedIndexed = path.resolve(indexedPath);
            if (normalizedTarget === normalizedIndexed) {
                console.log(`[HYBRID-HANDLER] 🔧 Using MCP index status (exact match): ${targetPath}`);
                return { isIndexed: true, isIndexing: false, indexedPath, source: 'mcp' };
            }
        }
        
        if (indexing.includes(targetPath)) {
            console.log(`[HYBRID-HANDLER] 🔧 Using MCP indexing status: ${targetPath}`);
            return { isIndexed: false, isIndexing: true, indexingPath: targetPath, source: 'mcp' };
        }

        console.log(`[HYBRID-HANDLER] ❌ No index found for: ${targetPath}`);
        return { isIndexed: false, isIndexing: false, source: 'mcp' };
    }

    /**
     * 处理索引请求 - 支持独立索引或提供 VSCode 指导
     */
    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, ignorePatterns } = args;
        const forceReindex = force || false;
        const splitterType = splitter || 'ast';
        const customIgnorePatterns = ignorePatterns || [];
        const absolutePath = ensureAbsolutePath(codebasePath);

        try {
            // 验证路径
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // 检查共享状态中的索引状态（统一检查）
            const sharedStatus = this.sharedStateManager.checkIndexingStatus(absolutePath);
            
            if (sharedStatus.isIndexed && !forceReindex) {
                const indexedCodebases = this.sharedStateManager.getIndexedCodebases();
                const metadata = indexedCodebases.find(m => path.resolve(m.path) === path.resolve(absolutePath));
                const statsInfo = metadata?.stats ? ` (${metadata.stats.indexedFiles} files, ${metadata.stats.totalChunks} chunks)` : '';
                
                return {
                    content: [{
                        type: "text",
                        text: `✅ Codebase '${absolutePath}' is already indexed${statsInfo}.\n\n` +
                              `You can directly search the codebase. Use force=true to re-index.`
                    }]
                };
            }

            if (sharedStatus.isIndexing) {
                const progress = this.sharedStateManager.getIndexingProgress(absolutePath);
                if (progress) {
                    const elapsed = Math.round((Date.now() - progress.startTime) / 1000);
                    return {
                        content: [{
                            type: "text",
                            text: `🔄 Codebase '${absolutePath}' is currently being indexed.\n\n` +
                                  `Progress: ${progress.phase} (${progress.percentage}%)\n` +
                                  `Elapsed time: ${elapsed} seconds\n\n` +
                                  `Search will be available once indexing completes.`
                        }]
                    };
                }
                
                return {
                    content: [{
                        type: "text",
                        text: `🔄 Codebase '${absolutePath}' is already being indexed. Please wait for completion.`
                    }]
                };
            }

            // 开始 MCP 独立索引
            console.log(`[HYBRID-HANDLER] 🔧 Starting independent MCP indexing for: ${absolutePath}`);
            
            // 验证集合创建（来自原始 handlers.ts）
            try {
                const normalizedPath = path.resolve(absolutePath);
                const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
                const collectionName = `code_chunks_${hash.substring(0, 8)}`;

                const embeddingProvider = this.codeContext['embedding'];
                const dimension = embeddingProvider.getDimension();

                if (forceReindex) {
                    try {
                        await this.codeContext['vectorDatabase'].dropCollection(collectionName);
                    } catch (dropError: any) {
                        // Collection might not exist
                    }
                }

                await this.codeContext['vectorDatabase'].createCollection(
                    collectionName,
                    dimension,
                    `Code context collection: ${collectionName}`
                );

                await this.codeContext['vectorDatabase'].dropCollection(collectionName);
            } catch (validationError: any) {
                const errorMessage = typeof validationError === 'string' ? validationError :
                    (validationError instanceof Error ? validationError.message : String(validationError));

                if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                    return {
                        content: [{
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE
                        }],
                        isError: true
                    };
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Error validating collection creation: ${validationError.message || validationError}`
                        }],
                        isError: true
                    };
                }
            }

            // 添加自定义忽略模式
            if (customIgnorePatterns.length > 0) {
                this.codeContext.addCustomIgnorePatterns(customIgnorePatterns);
            }

            // 添加到索引列表
            this.snapshotManager.addIndexingCodebase(absolutePath);
            this.snapshotManager.saveCodebaseSnapshot();

            // 开始后台索引
            this.startBackgroundIndexing(absolutePath, forceReindex, splitterType);

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `🔧 Started MCP independent indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${ignoreInfo}\n\n` +
                          `Indexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.\n\n` +
                          `💡 For better indexing experience with progress monitoring, consider using the VSCode extension.`
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error starting indexing: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    /**
     * 后台索引处理
     */
    private async startBackgroundIndexing(codebasePath: string, forceReindex: boolean, splitterType: string): Promise<void> {
        const absolutePath = codebasePath;

        try {
            console.log(`[HYBRID-HANDLER] 🔧 Starting background indexing for: ${absolutePath}`);

            // 创建进度跟踪
            const progress: IndexingProgress = {
                path: absolutePath,
                phase: 'Preparing...',
                current: 0,
                total: 0,
                percentage: 0,
                startTime: Date.now(),
                lastUpdated: Date.now(),
                status: 'preparing'
            };

            // 将进度同时保存到本地和共享状态
            this.activeIndexing.set(absolutePath, progress);
            this.sharedStateManager.addIndexingProgress(progress);

            // 初始化文件同步器
            const { FileSynchronizer } = await import("@zilliz/code-context-core");
            const ignorePatterns = this.codeContext['ignorePatterns'] || [];
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns);
            await synchronizer.initialize();

            // 生成集合名称并存储同步器
            const normalizedPath = path.resolve(absolutePath);
            const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
            const collectionName = `code_chunks_${hash.substring(0, 8)}`;
            this.codeContext['synchronizers'].set(collectionName, synchronizer);

            // 开始索引
            progress.status = 'indexing';
            progress.phase = 'Indexing files...';
            this.activeIndexing.set(absolutePath, progress);

            const stats = await this.codeContext.indexCodebase(
                absolutePath,
                (progressInfo) => {
                    progress.phase = progressInfo.phase;
                    progress.current = progressInfo.current;
                    progress.total = progressInfo.total;
                    progress.percentage = progressInfo.percentage;
                    progress.lastUpdated = Date.now();
                    progress.status = 'indexing';
                    
                    // 同步更新本地和共享状态
                    this.activeIndexing.set(absolutePath, progress);
                    this.sharedStateManager.updateIndexingProgress(absolutePath, {
                        phase: progress.phase,
                        current: progress.current,
                        total: progress.total,
                        percentage: progress.percentage,
                        status: progress.status
                    });
                }
            );

            // 索引完成
            progress.status = 'completed';
            progress.stats = {
                indexedFiles: stats.indexedFiles,
                totalChunks: stats.totalChunks
            };
            progress.percentage = 100;
            progress.phase = 'Completed';
            this.activeIndexing.set(absolutePath, progress);

            // 移动到已索引列表
            this.snapshotManager.moveFromIndexingToIndexed(absolutePath);
            this.snapshotManager.saveCodebaseSnapshot();

            console.log(`[HYBRID-HANDLER] ✅ Background indexing completed: ${absolutePath} (${stats.indexedFiles} files, ${stats.totalChunks} chunks)`);

            // 延迟清理进度信息
            setTimeout(() => {
                this.activeIndexing.delete(absolutePath);
            }, 2000);

        } catch (error: any) {
            console.error(`[HYBRID-HANDLER] ❌ Background indexing failed for ${absolutePath}:`, error);
            
            // 从索引列表中移除
            this.snapshotManager.removeIndexingCodebase(absolutePath);
            this.snapshotManager.saveCodebaseSnapshot();
            
            // 清理进度信息
            this.activeIndexing.delete(absolutePath);
        }
    }

    /**
     * 处理搜索请求 - 优先使用可用的索引
     */
    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10 } = args;
        const resultLimit = limit || 10;
        const absolutePath = ensureAbsolutePath(codebasePath);

        try {
            // 验证路径
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            // 检查索引状态
            const { isIndexed, isIndexing, indexedPath, source } = this.checkIndexingStatus(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `❌ Codebase '${absolutePath}' is not indexed.\n\n` +
                              `Please index it first using:\n` +
                              `• VSCode extension: "Semantic Code Search: Index Codebase" command\n` +
                              `• MCP server: Use the index_codebase tool`
                    }],
                    isError: true
                };
            }

            const searchPath = indexedPath || absolutePath;
            
            // 显示索引状态和来源
            let statusMessage = '';
            if (isIndexing) {
                if (source === 'vscode') {
                    const progress = this.sharedStateManager.getIndexingProgress(searchPath);
                    if (progress) {
                        statusMessage = `\n⚠️ **Indexing in Progress** (VSCode): ${progress.phase} - ${progress.percentage}%. Search results may be incomplete.`;
                    } else {
                        statusMessage = `\n⚠️ **Indexing in Progress** (VSCode): Search results may be incomplete.`;
                    }
                } else {
                    const progress = this.activeIndexing.get(searchPath);
                    if (progress) {
                        statusMessage = `\n⚠️ **Indexing in Progress** (MCP): ${progress.phase} - ${progress.percentage}%. Search results may be incomplete.`;
                    } else {
                        statusMessage = `\n⚠️ **Indexing in Progress** (MCP): Search results may be incomplete.`;
                    }
                }
            }

            console.log(`[HYBRID-HANDLER] 🔍 Searching in codebase: ${absolutePath} (source: ${source})`);

            // 执行搜索
            const searchResults = await this.codeContext.semanticSearch(
                searchPath,
                query,
                Math.min(resultLimit, 50),
                0.3
            );

            // 过滤结果（如果使用父目录索引）
            let filteredResults = searchResults;
            if (searchPath !== absolutePath) {
                filteredResults = searchResults.filter(result => {
                    const resultPath = path.join(searchPath, result.relativePath);
                    const normalizedResultPath = path.resolve(resultPath);
                    const normalizedTargetPath = path.resolve(absolutePath);
                    
                    return normalizedResultPath.startsWith(normalizedTargetPath + path.sep) || 
                           normalizedResultPath === normalizedTargetPath;
                });
            }

            if (filteredResults.length === 0) {
                let noResultsMessage = `No results found for query: "${query}" in codebase '${absolutePath}'`;
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: Indexing is in progress. Try again after completion.`;
                }
                return {
                    content: [{
                        type: "text",
                        text: noResultsMessage
                    }]
                };
            }

            // 格式化结果
            const formattedResults = filteredResults.map((result: any, index: number) => {
                const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                const context = truncateContent(result.content, 5000);
                const codebaseInfo = path.basename(absolutePath);

                return `${index + 1}. Code snippet (${result.language}) [${codebaseInfo}]\n` +
                    `   Location: ${location}\n` +
                    `   Score: ${result.score.toFixed(3)}\n` +
                    `   Context: \n\`\`\`${result.language}\n${context}\n\`\`\`\n`;
            }).join('\n');

            let resultMessage = `Found ${filteredResults.length} results for query: "${query}" in codebase '${absolutePath}'${statusMessage}`;
            
            if (source === 'vscode') {
                resultMessage += `\n\n🔗 **Index Source**: VSCode extension`;
            } else {
                resultMessage += `\n\n🔧 **Index Source**: MCP server`;
            }
            
            if (searchPath !== absolutePath) {
                resultMessage += `\n📁 **Note**: Using index from parent directory '${searchPath}'`;
            }
            
            resultMessage += `\n\n${formattedResults}`;

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }]
            };

        } catch (error: any) {
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error searching code: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    /**
     * 处理清除索引请求
     */
    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;
        const absolutePath = ensureAbsolutePath(codebasePath);

        try {
            // 验证路径
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            const { isIndexed, isIndexing, source } = this.checkIndexingStatus(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `ℹ️ Codebase '${absolutePath}' is not indexed.`
                    }]
                };
            }

            if (source === 'vscode') {
                return {
                    content: [{
                        type: "text",
                        text: `🔗 Codebase '${absolutePath}' is managed by VSCode extension.\n\n` +
                              `To clear the index, please use the VSCode extension:\n` +
                              `• Use "Semantic Code Search: Clear Index" command\n` +
                              `• Or click the Code Context status bar item`
                    }]
                };
            }

            // MCP 独立清除索引
            console.log(`[HYBRID-HANDLER] 🔧 Clearing MCP index for: ${absolutePath}`);

            // 取消正在进行的索引
            if (this.activeIndexing.has(absolutePath)) {
                this.activeIndexing.delete(absolutePath);
            }

            // 清除向量数据库索引
            await this.codeContext.clearIndex(absolutePath);

            // 从快照中移除
            this.snapshotManager.removeIndexedCodebase(absolutePath);
            this.snapshotManager.removeIndexingCodebase(absolutePath);
            this.snapshotManager.saveCodebaseSnapshot();

            return {
                content: [{
                    type: "text",
                    text: `✅ Successfully cleared MCP index for codebase '${absolutePath}'.`
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error clearing index: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    /**
     * 获取索引状态
     */
    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath } = args;

        try {
            if (codebasePath) {
                const absolutePath = ensureAbsolutePath(codebasePath);
                
                if (!fs.existsSync(absolutePath)) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                        }],
                        isError: true
                    };
                }

                const { isIndexed, isIndexing, source } = this.checkIndexingStatus(absolutePath);

                if (isIndexed) {
                    let statsInfo = '';
                    if (source === 'vscode') {
                        const indexed = this.sharedStateManager.getIndexedCodebases();
                        const metadata = indexed.find(m => path.resolve(m.path) === path.resolve(absolutePath));
                        if (metadata?.stats) {
                            statsInfo = ` (${metadata.stats.indexedFiles} files, ${metadata.stats.totalChunks} chunks)`;
                        }
                    }

                    return {
                        content: [{
                            type: "text",
                            text: `✅ Codebase '${absolutePath}' is fully indexed${statsInfo}.\n` +
                                  `Index managed by: ${source === 'vscode' ? 'VSCode extension' : 'MCP server'}`
                        }]
                    };
                } else if (isIndexing) {
                    let progressInfo = '';
                    if (source === 'vscode') {
                        const progress = this.sharedStateManager.getIndexingProgress(absolutePath);
                        if (progress) {
                            const elapsed = Math.round((Date.now() - progress.startTime) / 1000);
                            progressInfo = `\n• Phase: ${progress.phase}\n• Progress: ${progress.percentage}%\n• Elapsed: ${elapsed}s`;
                        }
                    } else {
                        const progress = this.activeIndexing.get(absolutePath);
                        if (progress) {
                            const elapsed = Math.round((Date.now() - progress.startTime) / 1000);
                            progressInfo = `\n• Phase: ${progress.phase}\n• Progress: ${progress.percentage}%\n• Elapsed: ${elapsed}s`;
                        }
                    }

                    return {
                        content: [{
                            type: "text",
                            text: `🔄 Codebase '${absolutePath}' is being indexed by ${source === 'vscode' ? 'VSCode extension' : 'MCP server'}.${progressInfo}`
                        }]
                    };
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `❌ Codebase '${absolutePath}' is not indexed.\n` +
                                  `Index it using VSCode extension or MCP server.`
                        }]
                    };
                }
            } else {
                // 获取所有状态
                const vscodeState = this.sharedStateManager.getState();
                const mcpIndexed = this.snapshotManager.getIndexedCodebases();
                const mcpIndexing = this.snapshotManager.getIndexingCodebases();

                let statusText = "Code Context Index Status:\n\n";

                if (vscodeState.indexes.length > 0) {
                    statusText += `VSCode Extension Indexes (${vscodeState.indexes.length}):\n`;
                    for (const index of vscodeState.indexes) {
                        const stats = index.stats ? ` (${index.stats.indexedFiles} files, ${index.stats.totalChunks} chunks)` : '';
                        statusText += `• ${index.path}${stats}\n`;
                    }
                    statusText += '\n';
                }

                if (vscodeState.activeIndexing.length > 0) {
                    statusText += `VSCode Extension Indexing (${vscodeState.activeIndexing.length}):\n`;
                    for (const progress of vscodeState.activeIndexing) {
                        statusText += `• ${progress.path} - ${progress.phase} (${progress.percentage}%)\n`;
                    }
                    statusText += '\n';
                }

                if (mcpIndexed.length > 0) {
                    statusText += `MCP Server Indexes (${mcpIndexed.length}):\n`;
                    for (const path of mcpIndexed) {
                        statusText += `• ${path}\n`;
                    }
                    statusText += '\n';
                }

                if (mcpIndexing.length > 0) {
                    statusText += `MCP Server Indexing (${mcpIndexing.length}):\n`;
                    for (const path of mcpIndexing) {
                        const progress = this.activeIndexing.get(path);
                        if (progress) {
                            statusText += `• ${path} - ${progress.phase} (${progress.percentage}%)\n`;
                        } else {
                            statusText += `• ${path} - Preparing...\n`;
                        }
                    }
                    statusText += '\n';
                }

                if (vscodeState.indexes.length === 0 && vscodeState.activeIndexing.length === 0 && 
                    mcpIndexed.length === 0 && mcpIndexing.length === 0) {
                    statusText += 'No codebases are currently indexed or being indexed.\n';
                }

                return {
                    content: [{
                        type: "text",
                        text: statusText.trim()
                    }]
                };
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
}
