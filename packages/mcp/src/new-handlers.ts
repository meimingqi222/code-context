import * as fs from "fs";
import * as path from "path";
import { CodeContext, COLLECTION_LIMIT_MESSAGE } from "@zilliz/code-context-core";
import { SharedStateManager } from "./shared-state.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "./utils.js";

/**
 * 新的 MCP 工具处理器，使用 SharedStateManager 从 VSCode 插件读取索引状态
 * 不再执行索引操作，只提供搜索和状态查询功能
 */
export class NewToolHandlers {
    private codeContext: CodeContext;
    private sharedStateManager: SharedStateManager;
    private currentWorkspace: string;

    constructor(codeContext: CodeContext, sharedStateManager: SharedStateManager) {
        this.codeContext = codeContext;
        this.sharedStateManager = sharedStateManager;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    /**
     * 处理索引请求 - 由于索引现在由 VSCode 插件管理，这里只提供指导信息
     */
    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, ignorePatterns } = args;
        const absolutePath = ensureAbsolutePath(codebasePath);

        try {
            // 验证路径存在
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // 验证是否为目录
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

            // 检查当前索引状态
            const { isIndexed, isIndexing, indexedPath, indexingPath } = this.sharedStateManager.checkIndexingStatus(absolutePath);

            if (isIndexed) {
                const indexPath = indexedPath || absolutePath;
                const indexedCodebases = this.sharedStateManager.getIndexedCodebases();
                const metadata = indexedCodebases.find(m => path.resolve(m.path) === path.resolve(indexPath));
                const statsInfo = metadata?.stats ? ` (${metadata.stats.indexedFiles} files, ${metadata.stats.totalChunks} chunks)` : '';
                
                if (!force) {
                    return {
                        content: [{
                            type: "text",
                            text: `✅ Codebase '${absolutePath}' is already indexed${statsInfo}.\n\n` +
                                  `The indexing was performed by the VSCode extension. You can now search the codebase directly.\n\n` +
                                  `If you want to re-index, please use the VSCode extension or set force=true.`
                        }]
                    };
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `⚠️ To re-index codebase '${absolutePath}', please use the VSCode extension.\n\n` +
                                  `The MCP server can only read existing indexes created by the VSCode extension. ` +
                                  `To perform indexing operations, please:\n\n` +
                                  `1. Open the codebase in VSCode\n` +
                                  `2. Use the "Semantic Code Search: Index Codebase" command\n` +
                                  `3. The indexing progress will be visible in VSCode\n` +
                                  `4. Once complete, you can search using this MCP server`
                        }]
                    };
                }
            }

            if (isIndexing) {
                const indexingCodebases = this.sharedStateManager.getIndexingCodebases();
                const progress = indexingCodebases.find(p => path.resolve(p.path) === path.resolve(indexingPath || absolutePath));
                
                if (progress) {
                    const elapsed = Math.round((Date.now() - progress.startTime) / 1000);
                    return {
                        content: [{
                            type: "text",
                            text: `🔄 Codebase '${absolutePath}' is currently being indexed by the VSCode extension.\n\n` +
                                  `Progress: ${progress.phase} (${progress.percentage}%)\n` +
                                  `Elapsed time: ${elapsed} seconds\n\n` +
                                  `You can monitor the progress in VSCode and search will be available once indexing completes.`
                        }]
                    };
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `🔄 Codebase '${absolutePath}' is being indexed, but detailed progress is not available.\n\n` +
                                  `Please check VSCode for indexing progress.`
                        }]
                    };
                }
            }

            // 如果没有索引，提供指导
            return {
                content: [{
                    type: "text",
                    text: `📚 Codebase '${absolutePath}' is not indexed.\n\n` +
                          `To index this codebase, please:\n\n` +
                          `1. Open the codebase in VSCode with the Semantic Code Search extension installed\n` +
                          `2. Use the command "Semantic Code Search: Index Codebase" or click the status bar\n` +
                          `3. Monitor the indexing progress in VSCode's status bar and notification area\n` +
                          `4. Once indexing is complete, you can search using this MCP server\n\n` +
                          `The VSCode extension provides a comprehensive indexing interface with:\n` +
                          `• Real-time progress monitoring\n` +
                          `• Cancellation support\n` +
                          `• Detailed progress phases\n` +
                          `• Error handling and recovery\n\n` +
                          `After indexing in VSCode, this MCP server will automatically detect and use the indexed data.`
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error checking indexing status: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    /**
     * 处理代码搜索请求
     */
    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10 } = args;
        const resultLimit = limit || 10;

        try {
            const absolutePath = ensureAbsolutePath(codebasePath);

            // 验证路径存在
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // 验证是否为目录
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

            // 智能检查索引状态
            const { isIndexed, isIndexing, indexedPath } = this.sharedStateManager.checkIndexingStatus(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `❌ Codebase '${absolutePath}' is not indexed.\n\n` +
                              `Please index the codebase first using the VSCode extension:\n` +
                              `1. Open VSCode in this directory\n` +
                              `2. Use "Semantic Code Search: Index Codebase" command\n` +
                              `3. Wait for indexing to complete\n` +
                              `4. Then you can search using this MCP server`
                    }],
                    isError: true
                };
            }

            // 使用索引路径进行搜索
            const searchPath = indexedPath || absolutePath;

            // 显示索引状态信息
            let indexingStatusMessage = '';
            if (isIndexing) {
                const progress = this.sharedStateManager.getIndexingProgress(searchPath);
                if (progress) {
                    indexingStatusMessage = `\n⚠️ **Indexing in Progress**: This codebase is currently being indexed (${progress.phase} - ${progress.percentage}%). Search results may be incomplete until indexing completes.`;
                } else {
                    indexingStatusMessage = `\n⚠️ **Indexing in Progress**: This codebase is currently being indexed. Search results may be incomplete until indexing completes.`;
                }
            }

            console.log(`[SEARCH] Searching in codebase: ${absolutePath}`);
            console.log(`[SEARCH] Using indexed path: ${searchPath}`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // 执行搜索
            const searchResults = await this.codeContext.semanticSearch(
                searchPath,
                query,
                Math.min(resultLimit, 50),
                0.3
            );

            // 如果使用的是父目录的索引，需要过滤结果
            let filteredResults = searchResults;
            if (searchPath !== absolutePath) {
                const targetRelativePath = path.relative(searchPath, absolutePath);
                console.log(`[SEARCH] 📊 Filtering results for subdirectory: ${targetRelativePath}`);
                filteredResults = searchResults.filter(result => {
                    const resultPath = path.join(searchPath, result.relativePath);
                    const normalizedResultPath = path.resolve(resultPath);
                    const normalizedTargetPath = path.resolve(absolutePath);
                    
                    return normalizedResultPath.startsWith(normalizedTargetPath + path.sep) || 
                           normalizedResultPath === normalizedTargetPath;
                });
                console.log(`[SEARCH] 📋 Filtered ${searchResults.length} to ${filteredResults.length} results for target directory`);
            }

            console.log(`[SEARCH] ✅ Search completed! Found ${filteredResults.length} relevant results`);

            if (filteredResults.length === 0) {
                let noResultsMessage = `No results found for query: "${query}" in codebase '${absolutePath}'`;
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: This codebase is still being indexed. Try searching again after indexing completes, or the query may not match any indexed content.`;
                }
                if (searchPath !== absolutePath) {
                    noResultsMessage += `\n\nNote: Searched in parent directory '${searchPath}' but no results were found within the target subdirectory '${absolutePath}'.`;
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

            let resultMessage = `Found ${filteredResults.length} results for query: "${query}" in codebase '${absolutePath}'${indexingStatusMessage}`;
            if (searchPath !== absolutePath) {
                resultMessage += `\n\n📁 **Note**: Using index from parent directory '${searchPath}' to search within '${absolutePath}'`;
            }
            resultMessage += `\n\n${formattedResults}`;

            if (isIndexing) {
                resultMessage += `\n\n💡 **Tip**: This codebase is still being indexed in VSCode. More results may become available as indexing progresses.`;
            }

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
                    text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first using the VSCode extension.`
                }],
                isError: true
            };
        }
    }

    /**
     * 处理清除索引请求 - 提供指导信息
     */
    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;

        try {
            const absolutePath = ensureAbsolutePath(codebasePath);

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

            // 检查索引状态
            const { isIndexed, isIndexing } = this.sharedStateManager.checkIndexingStatus(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `ℹ️ Codebase '${absolutePath}' is not indexed, so there's nothing to clear.`
                    }]
                };
            }

            // 提供清除索引的指导
            return {
                content: [{
                    type: "text",
                    text: `🗑️ To clear the index for codebase '${absolutePath}', please use the VSCode extension.\n\n` +
                          `The MCP server cannot directly clear indexes as they are managed by the VSCode extension. ` +
                          `To clear the index:\n\n` +
                          `1. Open VSCode in the codebase directory\n` +
                          `2. Use the "Semantic Code Search: Clear Index" command\n` +
                          `3. Or click on the Code Context status bar item and select the clear option\n\n` +
                          `The index will be removed from both the vector database and the shared state.`
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error handling clear index request: ${error.message || error}`
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
                // 获取特定代码库的状态
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

                const { isIndexed, isIndexing, indexedPath, indexingPath } = this.sharedStateManager.checkIndexingStatus(absolutePath);
                const progress = this.sharedStateManager.getIndexingProgress(absolutePath);

                if (isIndexed) {
                    const indexedCodebases = this.sharedStateManager.getIndexedCodebases();
                    const metadata = indexedCodebases.find(m => 
                        path.resolve(m.path) === path.resolve(indexedPath || absolutePath)
                    );
                    const stats = metadata?.stats ? ` (${metadata.stats.indexedFiles} files, ${metadata.stats.totalChunks} chunks)` : '';
                    const indexedTime = metadata ? new Date(metadata.lastIndexed).toLocaleString() : 'Unknown';
                    
                    return {
                        content: [{
                            type: "text",
                            text: `✅ Codebase '${absolutePath}' is fully indexed${stats}.\n` +
                                  `Indexed on: ${indexedTime}\n` +
                                  `Index managed by: VSCode extension`
                        }]
                    };
                } else if (isIndexing && progress) {
                    const elapsed = Math.round((Date.now() - progress.startTime) / 1000);
                    const estimatedTotal = progress.percentage > 0 ? (elapsed / progress.percentage) * 100 : 0;
                    const estimatedRemaining = Math.max(0, estimatedTotal - elapsed);
                    const remainingSeconds = Math.round(estimatedRemaining);

                    return {
                        content: [{
                            type: "text",
                            text: `🔄 Codebase '${absolutePath}' is being indexed by the VSCode extension:\n` +
                                  `• Phase: ${progress.phase}\n` +
                                  `• Progress: ${progress.percentage}% (${progress.current}/${progress.total})\n` +
                                  `• Elapsed: ${elapsed}s\n` +
                                  `• Estimated remaining: ${remainingSeconds}s\n` +
                                  `• Last updated: ${new Date(progress.lastUpdated).toLocaleTimeString()}\n` +
                                  `• Status: ${progress.status}`
                        }]
                    };
                } else if (isIndexing) {
                    return {
                        content: [{
                            type: "text",
                            text: `🔄 Codebase '${absolutePath}' is being indexed by the VSCode extension.\n` +
                                  `Detailed progress information is not available. Please check VSCode for progress details.`
                        }]
                    };
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `❌ Codebase '${absolutePath}' is not indexed.\n` +
                                  `Use the VSCode extension to index this codebase.`
                        }]
                    };
                }
            } else {
                // 获取所有代码库的状态
                return {
                    content: [{
                        type: "text",
                        text: this.sharedStateManager.getStatusReport()
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
