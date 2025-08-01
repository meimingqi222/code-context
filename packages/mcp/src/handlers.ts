import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { CodeContext, COLLECTION_LIMIT_MESSAGE } from "@zilliz/code-context-core";
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
}

export class ToolHandlers {
    private codeContext: CodeContext;
    private snapshotManager: SnapshotManager;
    private indexingProgress = new Map<string, IndexingProgress>();
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    // 新增：用于跟踪和取消正在运行的索引任务
    private activeIndexingTasks = new Map<string, AbortController>();
    private currentWorkspace: string;

    constructor(codeContext: CodeContext, snapshotManager: SnapshotManager) {
        this.codeContext = codeContext;
        this.snapshotManager = snapshotManager;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    /**
     * 智能检查索引状态：检查当前路径或其父目录是否已被索引
     * @param targetPath 目标路径
     * @returns 索引状态信息
     */
    private checkIndexingStatus(targetPath: string): { isIndexed: boolean; isIndexing: boolean; indexedPath?: string } {
        const indexed = this.snapshotManager.getIndexedCodebases();
        const indexing = this.snapshotManager.getIndexingCodebases();
        
        // 首先检查精确匹配
        if (indexed.includes(targetPath)) {
            console.log(`[INDEX-CHECK] ✅ Exact match found - '${targetPath}' is indexed`);
            return { isIndexed: true, isIndexing: false, indexedPath: targetPath };
        }
        
        if (indexing.includes(targetPath)) {
            console.log(`[INDEX-CHECK] 🔄 Exact match found - '${targetPath}' is being indexed`);
            return { isIndexed: false, isIndexing: true, indexedPath: targetPath };
        }
        
        // 检查父目录是否已被索引（父目录包含子目录）
        const normalizedTarget = path.resolve(targetPath);
        
        for (const indexedPath of indexed) {
            const normalizedIndexed = path.resolve(indexedPath);
            // 检查目标路径是否在已索引的路径下
            if (normalizedTarget.startsWith(normalizedIndexed + path.sep) || normalizedTarget === normalizedIndexed) {
                console.log(`[INDEX-CHECK] 📁 Parent directory '${indexedPath}' contains target '${targetPath}'`);
                return { isIndexed: true, isIndexing: false, indexedPath: indexedPath };
            }
        }
        
        for (const indexingPath of indexing) {
            const normalizedIndexing = path.resolve(indexingPath);
            // 检查目标路径是否在正在索引的路径下
            if (normalizedTarget.startsWith(normalizedIndexing + path.sep) || normalizedTarget === normalizedIndexing) {
                console.log(`[INDEX-CHECK] 📁 Parent directory '${indexingPath}' (being indexed) contains target '${targetPath}'`);
                return { isIndexed: false, isIndexing: true, indexedPath: indexingPath };
            }
        }
        
        console.log(`[INDEX-CHECK] ❌ No indexed parent found for '${targetPath}'`);
        return { isIndexed: false, isIndexing: false };
    }
    
    /**
     * Sync indexed codebases from Zilliz Cloud collections
     * This method fetches all collections from the vector database,
     * gets the first document from each collection to extract codebasePath from metadata,
     * and updates the snapshot with discovered codebases.
     * 
     * Logic: Compare mcp-codebase-snapshot.json with zilliz cloud collections
     * - If local snapshot has extra directories (not in cloud), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */
    private async syncIndexedCodebasesFromCloud(): Promise<void> {
        try {
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);

            // Get all collections using the interface method
            const vectorDb = this.codeContext['vectorDatabase'];

            // Use the new listCollections method from the interface
            const collections = await vectorDb.listCollections();

            console.log(`[SYNC-CLOUD] 📋 Found ${collections.length} collections in Zilliz Cloud`);

            if (collections.length === 0) {
                console.log(`[SYNC-CLOUD] ✅ No collections found in cloud`);
                // If no collections in cloud, remove all local codebases
                const localCodebases = this.snapshotManager.getIndexedCodebases();
                if (localCodebases.length > 0) {
                    console.log(`[SYNC-CLOUD] 🧹 Removing ${localCodebases.length} local codebases as cloud has no collections`);
                    for (const codebasePath of localCodebases) {
                        this.snapshotManager.removeIndexedCodebase(codebasePath);
                        console.log(`[SYNC-CLOUD] ➖ Removed local codebase: ${codebasePath}`);
                    }
                    this.snapshotManager.saveCodebaseSnapshot();
                    console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match empty cloud state`);
                }
                return;
            }

            const cloudCodebases = new Set<string>();

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match the code_chunks pattern
                    if (!collectionName.startsWith('code_chunks_')) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionName}`);
                        continue;
                    }

                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionName}`);

                    // Query the first document to get metadata
                    const results = await vectorDb.query(
                        collectionName,
                        '', // Empty filter to get all results
                        ['metadata'], // Only fetch metadata field
                        1 // Only need one result to extract codebasePath
                    );

                    if (results && results.length > 0) {
                        const firstResult = results[0];
                        const metadataStr = firstResult.metadata;

                        if (metadataStr) {
                            try {
                                const metadata = JSON.parse(metadataStr);
                                const codebasePath = metadata.codebasePath;

                                if (codebasePath && typeof codebasePath === 'string') {
                                    console.log(`[SYNC-CLOUD] 📍 Found codebase path: ${codebasePath} in collection: ${collectionName}`);
                                    cloudCodebases.add(codebasePath);
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                                }
                            } catch (parseError) {
                                console.warn(`[SYNC-CLOUD] ⚠️  Failed to parse metadata JSON for collection ${collectionName}:`, parseError);
                            }
                        } else {
                            console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionName}`);
                        }
                    } else {
                        console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionName} is empty`);
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
                    // Continue with next collection
                }
            }

            console.log(`[SYNC-CLOUD] 📊 Found ${cloudCodebases.size} valid codebases in cloud`);

            // Get current local codebases
            const localCodebases = new Set(this.snapshotManager.getIndexedCodebases());
            console.log(`[SYNC-CLOUD] 📊 Found ${localCodebases.size} local codebases in snapshot`);

            let hasChanges = false;

            // Remove local codebases that don't exist in cloud
            for (const localCodebase of localCodebases) {
                if (!cloudCodebases.has(localCodebase)) {
                    this.snapshotManager.removeIndexedCodebase(localCodebase);
                    hasChanges = true;
                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localCodebase}`);
                }
            }

            // Note: We don't add cloud codebases that are missing locally (as per user requirement)
            console.log(`[SYNC-CLOUD] ℹ️  Skipping addition of cloud codebases not present locally (per sync policy)`);

            if (hasChanges) {
                this.snapshotManager.saveCodebaseSnapshot();
                console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match cloud state`);
            } else {
                console.log(`[SYNC-CLOUD] ✅ Local snapshot already matches cloud state`);
            }

            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, error.message || error);
            // Don't throw - this is not critical for the main functionality
        }
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, ignorePatterns } = args;
        const forceReindex = force || false;
        const splitterType = splitter || 'ast'; // Default to AST
        const customIgnorePatterns = ignorePatterns || [];

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Validate splitter parameter
            if (splitterType !== 'ast' && splitterType !== 'langchain') {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Invalid splitter type '${splitterType}'. Must be 'ast' or 'langchain'.`
                    }],
                    isError: true
                };
            }
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
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

            // Check if already indexing
            if (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`
                    }],
                    isError: true
                };
            }

            // Check if already indexed (unless force is true)
            if (!forceReindex && this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already indexed. Use force=true to re-index.`
                    }],
                    isError: true
                };
            }

            // If force reindex and codebase is already indexed, remove it from indexed list
            if (forceReindex && this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                console.log(`[FORCE-REINDEX] 🔄 Removing '${absolutePath}' from indexed list for re-indexing`);
                this.snapshotManager.removeIndexedCodebase(absolutePath);
            }

            // 如果是强制重新索引，也需要取消现有的索引任务
            if (forceReindex && this.activeIndexingTasks.has(absolutePath)) {
                console.log(`[FORCE-REINDEX] 🛑 Cancelling existing indexing task for force reindex: ${absolutePath}`);
                const abortController = this.activeIndexingTasks.get(absolutePath);
                if (abortController) {
                    abortController.abort();
                    this.activeIndexingTasks.delete(absolutePath);
                    console.log(`[FORCE-REINDEX] ✅ Successfully cancelled existing indexing task: ${absolutePath}`);
                }
                // 等待一下让旧任务清理完成
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                const normalizedPath = path.resolve(absolutePath);
                const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
                const collectionName = `code_chunks_${hash.substring(0, 8)}`;

                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation for: ${collectionName}`);

                // Get embedding dimension for collection creation
                const embeddingProvider = this.codeContext['embedding'];
                const dimension = embeddingProvider.getDimension();

                // If force reindex, clear existing collection first
                if (forceReindex) {
                    console.log(`[INDEX-VALIDATION] 🧹 Force reindex enabled, clearing existing collection: ${collectionName}`);
                    try {
                        await this.codeContext['vectorDatabase'].dropCollection(collectionName);
                        console.log(`[INDEX-VALIDATION] ✅ Existing collection cleared: ${collectionName}`);
                    } catch (dropError: any) {
                        // Collection might not exist, which is fine
                        console.log(`[INDEX-VALIDATION] ℹ️  Collection ${collectionName} does not exist or already cleared`);
                    }
                }

                // Attempt to create collection - this will throw COLLECTION_LIMIT_MESSAGE if limit reached
                await this.codeContext['vectorDatabase'].createCollection(
                    collectionName,
                    dimension,
                    `Code context collection: ${collectionName}`
                );

                // If creation succeeds, immediately drop the test collection
                await this.codeContext['vectorDatabase'].dropCollection(collectionName);
                console.log(`[INDEX-VALIDATION] ✅ Collection creation validated successfully`);

            } catch (validationError: any) {
                const errorMessage = typeof validationError === 'string' ? validationError :
                    (validationError instanceof Error ? validationError.message : String(validationError));

                if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);

                    // CRITICAL: Immediately return the COLLECTION_LIMIT_MESSAGE to MCP client
                    return {
                        content: [{
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE
                        }],
                        isError: true
                    };
                } else {
                    // Handle other collection creation errors
                    console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                    return {
                        content: [{
                            type: "text",
                            text: `Error validating collection creation: ${validationError.message || validationError}`
                        }],
                        isError: true
                    };
                }
            }

            // Add custom ignore patterns if provided (before loading file-based patterns)
            if (customIgnorePatterns.length > 0) {
                console.log(`[IGNORE-PATTERNS] Adding ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`);
                this.codeContext.addCustomIgnorePatterns(customIgnorePatterns);
            }

            // Add to indexing list and save snapshot immediately
            this.snapshotManager.addIndexingCodebase(absolutePath);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed
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
                    text: `Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`
                }]
            };

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);

            // Ensure we always return a proper MCP response, never throw
            return {
                content: [{
                    type: "text",
                    text: `Error starting indexing: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    private async startBackgroundIndexing(codebasePath: string, forceReindex: boolean, splitterType: string) {
        const absolutePath = codebasePath;

        // 创建AbortController用于取消任务
        const abortController = new AbortController();
        this.activeIndexingTasks.set(absolutePath, abortController);

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            // Use the existing CodeContext instance for indexing.
            let contextForThisTask = this.codeContext;
            if (splitterType !== 'ast') {
                console.warn(`[BACKGROUND-INDEX] Non-AST splitter '${splitterType}' requested; falling back to AST splitter`);
            }

            // Generate collection name
            const normalizedPath = path.resolve(absolutePath);
            const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
            const collectionName = `code_chunks_${hash.substring(0, 8)}`;

            // Initialize file synchronizer with proper ignore patterns
            const { FileSynchronizer } = await import("@zilliz/code-context-core");
            const ignorePatterns = this.codeContext['ignorePatterns'] || [];
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns);
            await synchronizer.initialize();

            // Store synchronizer in the context's internal map
            this.codeContext['synchronizers'].set(collectionName, synchronizer);
            if (contextForThisTask !== this.codeContext) {
                contextForThisTask['synchronizers'].set(collectionName, synchronizer);
            }

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const embeddingProvider = this.codeContext['embedding'];
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} with dimension: ${embeddingProvider.getDimension()}`);

            // 检查任务是否被取消
            if (abortController.signal.aborted) {
                console.log(`[BACKGROUND-INDEX] 🛑 Indexing task was cancelled for: ${absolutePath}`);
                this.snapshotManager.removeIndexingCodebase(absolutePath);
                this.snapshotManager.saveCodebaseSnapshot();
                this.indexingProgress.delete(absolutePath);
                return;
            }

            // Start indexing with the appropriate context
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            
            // 创建一个包装的进度回调，用于检查取消状态
            const progressCallback = (progress: { phase: string; current: number; total: number; percentage: number }) => {
                if (abortController.signal.aborted) {
                    console.log(`[BACKGROUND-INDEX] 🛑 Indexing cancelled during progress for: ${absolutePath}`);
                    throw new Error('Indexing cancelled by user');
                }
                
                // 更新进度信息
                this.indexingProgress.set(absolutePath, {
                    path: absolutePath,
                    phase: progress.phase,
                    current: progress.current,
                    total: progress.total,
                    percentage: progress.percentage,
                    startTime: this.indexingProgress.get(absolutePath)?.startTime || Date.now(),
                    lastUpdated: Date.now()
                });
            };

            const stats = await contextForThisTask.indexCodebase(absolutePath, progressCallback);
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Move from indexing to indexed list
            this.snapshotManager.moveFromIndexingToIndexed(absolutePath);
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            // 检查是否是取消错误
            if (error.message === 'Indexing cancelled by user' || abortController.signal.aborted) {
                console.log(`[BACKGROUND-INDEX] 🛑 Indexing was cancelled for: ${absolutePath}`);
            } else {
                console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);
                console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${error.message || error}`);
            }
            
            // Remove from indexing list on error or cancellation
            this.snapshotManager.removeIndexingCodebase(absolutePath);
            this.snapshotManager.saveCodebaseSnapshot();
        } finally {
            // 清理资源
            this.activeIndexingTasks.delete(absolutePath);
            this.indexingProgress.delete(absolutePath);
            console.log(`[BACKGROUND-INDEX] 🧹 Cleaned up resources for: ${absolutePath}`);
        }
    }

    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10 } = args;
        const resultLimit = limit || 10;

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
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

            // 智能检查索引状态：检查当前路径或其父目录是否已被索引
            const { isIndexed, isIndexing, indexedPath } = this.checkIndexingStatus(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool.`
                    }],
                    isError: true
                };
            }

            // 如果使用的是父目录的索引，需要调整搜索路径
            const searchPath = indexedPath || absolutePath;

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            if (isIndexing) {
                indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${absolutePath}`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // Log embedding provider information before search
            const embeddingProvider = this.codeContext['embedding'];
            console.log(`[SEARCH] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} for semantic search`);
            console.log(`[SEARCH] 🔍 Generating embeddings for query using ${embeddingProvider.getProvider()}...`);

            // Search in the specified codebase (using the indexed path if it's a parent directory)
            const searchResults = await this.codeContext.semanticSearch(
                searchPath,
                query,
                Math.min(resultLimit, 50),
                0.3
            );
            
            // 如果使用的是父目录的索引，需要过滤结果以只显示目标路径下的文件
            let filteredResults = searchResults;
            if (searchPath !== absolutePath) {
                const targetRelativePath = path.relative(searchPath, absolutePath);
                console.log(`[SEARCH] 📊 Filtering results for subdirectory: ${targetRelativePath}`);
                filteredResults = searchResults.filter(result => {
                    const resultPath = path.join(searchPath, result.relativePath);
                    const normalizedResultPath = path.resolve(resultPath);
                    const normalizedTargetPath = path.resolve(absolutePath);
                    
                    // 检查结果文件是否在目标目录下
                    return normalizedResultPath.startsWith(normalizedTargetPath + path.sep) || 
                           normalizedResultPath === normalizedTargetPath;
                });
                console.log(`[SEARCH] 📋 Filtered ${searchResults.length} to ${filteredResults.length} results for target directory`);
            }

            console.log(`[SEARCH] ✅ Search completed! Found ${filteredResults.length} relevant results using ${embeddingProvider.getProvider()} embeddings`);

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

            // Format results (use filtered results)
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
                resultMessage += `\n\n💡 **Tip**: This codebase is still being indexed. More results may become available as indexing progresses.`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
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
                    text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first.`
                }],
                isError: true
            };
        }
    }

    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;

        if (this.snapshotManager.getIndexedCodebases().length === 0 && this.snapshotManager.getIndexingCodebases().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "No codebases are currently indexed or being indexed."
                }]
            };
        }

        try {
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
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

            // Check if this codebase is indexed or being indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed or being indexed.`
                    }],
                    isError: true
                };
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            // 检查是否有正在运行的索引任务，如果有则取消
            if (this.activeIndexingTasks.has(absolutePath)) {
                console.log(`[CLEAR] 🛑 Cancelling active indexing task for: ${absolutePath}`);
                const abortController = this.activeIndexingTasks.get(absolutePath);
                if (abortController) {
                    abortController.abort();
                    this.activeIndexingTasks.delete(absolutePath);
                    console.log(`[CLEAR] ✅ Successfully cancelled indexing task for: ${absolutePath}`);
                }
            }

            try {
                await this.codeContext.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: any) {
                const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return {
                    content: [{
                        type: "text",
                        text: errorMsg
                    }],
                    isError: true
                };
            }

            // Remove the cleared codebase from both lists
            this.snapshotManager.removeIndexedCodebase(absolutePath);
            this.snapshotManager.removeIndexingCodebase(absolutePath);

            // 清理进度信息
            this.indexingProgress.delete(absolutePath);

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultText
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
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
                    text: `Error clearing index: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath } = args;

        try {
            if (codebasePath) {
                // Get status for specific codebase
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

                const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
                const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);
                const progress = this.indexingProgress.get(absolutePath);

                if (isIndexed) {
                    const stats = this.indexingStats ? ` (${this.indexingStats.indexedFiles} files, ${this.indexingStats.totalChunks} chunks)` : '';
                    return {
                        content: [{
                            type: "text",
                            text: `Codebase '${absolutePath}' is fully indexed${stats}.`
                        }]
                    };
                } else if (isIndexing) {
                    if (progress) {
                        const elapsed = Date.now() - progress.startTime;
                        const elapsedSeconds = Math.round(elapsed / 1000);
                        const estimatedTotal = progress.percentage > 0 ? (elapsed / progress.percentage) * 100 : 0;
                        const estimatedRemaining = Math.max(0, estimatedTotal - elapsed);
                        const remainingSeconds = Math.round(estimatedRemaining / 1000);

                        return {
                            content: [{
                                type: "text",
                                text: `Codebase '${absolutePath}' is being indexed:\n` +
                                      `• Phase: ${progress.phase}\n` +
                                      `• Progress: ${progress.percentage}% (${progress.current}/${progress.total})\n` +
                                      `• Elapsed: ${elapsedSeconds}s\n` +
                                      `• Estimated remaining: ${remainingSeconds}s\n` +
                                      `• Last updated: ${new Date(progress.lastUpdated).toLocaleTimeString()}`
                            }]
                        };
                    } else {
                        return {
                            content: [{
                                type: "text",
                                text: `Codebase '${absolutePath}' is preparing to index...`
                            }]
                        };
                    }
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Codebase '${absolutePath}' is not indexed.`
                        }]
                    };
                }
            } else {
                // Get status for all codebases
                const indexed = this.snapshotManager.getIndexedCodebases();
                const indexing = this.snapshotManager.getIndexingCodebases();
                
                if (indexed.length === 0 && indexing.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: "No codebases are currently indexed or being indexed."
                        }]
                    };
                }

                let statusText = "";
                if (indexed.length > 0) {
                    statusText += `Indexed codebases:\n• ${indexed.join('\n• ')}\n\n`;
                }
                if (indexing.length > 0) {
                    statusText += `Indexing codebases:\n`;
                    for (const p of indexing) {
                        const progress = this.indexingProgress.get(p);
                        if (progress) {
                            statusText += `• ${p} (${progress.percentage}% - ${progress.phase})\n`;
                        } else {
                            statusText += `• ${p} (preparing to index...)\n`;
                        }
                    }
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