import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Context, COLLECTION_LIMIT_MESSAGE } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath, isPathIndexedOrNested, findIndexedParentDirectory } from "./utils.js";
import { TextSearcher, TextSearchOptions } from "./text-search.js";

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager | null = null;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;
    
    // 云端同步缓存机制 - 优化性能
    private cloudSyncCache: {
        timestamp: number;
        cloudCodebases: Set<string>;
    } | null = null;
    private readonly CLOUD_SYNC_CACHE_TTL = 300000; // 5分钟缓存 (300秒)

    constructor(context: Context, snapshotManager: SnapshotManager, syncManager?: SyncManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.syncManager = syncManager || null;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    /**
     * Smart path resolution that tries multiple common project root directories
     * and provides helpful error messages when paths can't be resolved.
     */
    private smartPathResolution(inputPath: string, operation: 'index' | 'search' | 'clear' | 'status'): { resolvedPath: string; pathInfo: string } {
        // If already absolute, return as-is
        if (path.isAbsolute(inputPath)) {
            return {
                resolvedPath: inputPath,
                pathInfo: inputPath
            };
        }

        const workspacePath = this.currentWorkspace;
        const possiblePaths = [
            path.resolve(workspacePath, inputPath),                    // Current workspace
            path.resolve(workspacePath, '..', inputPath),               // Parent directory
            path.resolve(workspacePath, '..', '..', inputPath),         // Grandparent directory
            path.resolve(process.cwd(), inputPath),                     // Current working directory
            path.resolve(process.cwd(), '..', inputPath),               // Parent of cwd
        ];

        // Try to find an existing path
        for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
                const stat = fs.statSync(possiblePath);
                if (stat.isDirectory()) {
                    return {
                        resolvedPath: possiblePath,
                        pathInfo: `${inputPath} → ${possiblePath}`
                    };
                }
            }
        }

        // If no path found, return the most likely candidate with helpful info
        const mostLikely = path.resolve(workspacePath, inputPath);
        return {
            resolvedPath: mostLikely,
            pathInfo: `${inputPath} → ${mostLikely} (path will be created/validated during ${operation})`
        };
    }

    /**
     * Find the parent directory that is actually indexed for a given subdirectory
     */
    private findIndexedParentPath(searchPath: string): string | null {
        const indexedCodebases = this.snapshotManager.getIndexedCodebases();

        for (const indexedPath of indexedCodebases) {
            if (isPathIndexedOrNested(searchPath, [indexedPath])) {
                return indexedPath;
            }
        }

        return null;
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
            // ✅ 性能优化: 检查缓存是否有效
            const now = Date.now();
            if (this.cloudSyncCache && 
                (now - this.cloudSyncCache.timestamp < this.CLOUD_SYNC_CACHE_TTL)) {
                const cacheAge = ((now - this.cloudSyncCache.timestamp) / 1000).toFixed(1);
                console.log(`[SYNC-CLOUD] ⚡ Using cached cloud sync data (age: ${cacheAge}s, TTL: ${this.CLOUD_SYNC_CACHE_TTL / 1000}s)`);
                console.log(`[SYNC-CLOUD] 💾 Cached ${this.cloudSyncCache.cloudCodebases.size} codebases`);
                return;
            }
            
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);
            const syncStartTime = Date.now();

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorDatabase();

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
            for (const collectionName of Array.from(collections)) {
                try {
                    const collectionStr = String(collectionName);
                    // Skip collections that don't match the code_chunks pattern (support both legacy and new collections)
                    if (!collectionStr.startsWith('code_chunks_') && !collectionStr.startsWith('hybrid_code_chunks_')) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionStr}`);
                        continue;
                    }

                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionStr}`);

                    // Query the first document to get metadata
                    const results = await vectorDb.query(
                        collectionStr,
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
                                    console.log(`[SYNC-CLOUD] 📍 Found codebase path: ${codebasePath} in collection: ${collectionStr}`);
                                    cloudCodebases.add(codebasePath);
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionStr}`);
                                }
                            } catch (parseError) {
                                console.warn(`[SYNC-CLOUD] ⚠️  Failed to parse metadata JSON for collection ${collectionStr}:`, parseError);
                            }
                        } else {
                            console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionStr}`);
                        }
                    } else {
                        console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionStr} is empty`);
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${String(collectionName)}:`, collectionError.message || collectionError);
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
            
            // ✅ 性能优化: 更新缓存
            this.cloudSyncCache = {
                timestamp: Date.now(),
                cloudCodebases: cloudCodebases
            };
            
            const syncDuration = ((Date.now() - syncStartTime) / 1000).toFixed(2);
            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully in ${syncDuration}s`);
            console.log(`[SYNC-CLOUD] 💾 Cached result for ${this.CLOUD_SYNC_CACHE_TTL / 1000}s`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, error.message || error);
            // Don't throw - this is not critical for the main functionality
        }
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, customExtensions, ignorePatterns } = args;
        const forceReindex = force || false;
        const splitterType = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
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
            
            // Smart path resolution with helpful feedback
            const { resolvedPath: absolutePath, pathInfo } = this.smartPathResolution(codebasePath, 'index');

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

            // NEW: Check if this directory is a subdirectory of an already indexed parent directory
            if (!forceReindex) {
                const indexedCodebases = this.snapshotManager.getIndexedCodebases();
                const indexingCodebases = this.snapshotManager.getIndexingCodebases();

                // Check against already indexed directories
                const indexedParent = findIndexedParentDirectory(absolutePath, indexedCodebases);
                if (indexedParent) {
                    console.log(`[DUPLICATE-PREVENTION] 🚫 Prevented indexing of subdirectory '${absolutePath}' because parent '${indexedParent}' is already indexed`);
                    return {
                        content: [{
                            type: "text",
                            text: `Cannot index '${absolutePath}' because its parent directory '${indexedParent}' is already indexed.\n\nThe parent directory indexing includes all subdirectories, so you can search in this directory using the existing index.\n\nIf you need to index this directory separately, use force=true, but this will create a duplicate index.`
                        }],
                        isError: true
                    };
                }

                // Check against directories currently being indexed
                const indexingParent = findIndexedParentDirectory(absolutePath, indexingCodebases);
                if (indexingParent) {
                    console.log(`[DUPLICATE-PREVENTION] 🚫 Prevented indexing of subdirectory '${absolutePath}' because parent '${indexingParent}' is currently being indexed`);
                    return {
                        content: [{
                            type: "text",
                            text: `Cannot index '${absolutePath}' because its parent directory '${indexingParent}' is currently being indexed.\n\nPlease wait for the parent directory indexing to complete. The parent directory indexing will include all subdirectories.`
                        }],
                        isError: true
                    };
                }
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

            //Check if the snapshot and cloud index are in sync
            if (this.snapshotManager.getIndexedCodebases().includes(absolutePath) !== await this.context.hasIndex(absolutePath)) {
                console.warn(`[INDEX-VALIDATION] ❌ Snapshot and cloud index mismatch: ${absolutePath}`);
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

            // If force reindex and codebase is already indexed, remove it
            if (forceReindex) {
                if (this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                    console.log(`[FORCE-REINDEX] 🔄 Removing '${absolutePath}' from indexed list for re-indexing`);
                    this.snapshotManager.removeIndexedCodebase(absolutePath);
                }
                if (await this.context.hasIndex(absolutePath)) {
                    console.log(`[FORCE-REINDEX] 🔄 Clearing index for '${absolutePath}'`);
                    await this.context.clearIndex(absolutePath);
                }
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
                const canCreateCollection = await this.context.getVectorDatabase().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);

                    // CRITICAL: Immediately return the COLLECTION_LIMIT_MESSAGE to MCP client
                    return {
                        content: [{
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE
                        }],
                        isError: true
                    };
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);
            } catch (validationError: any) {
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

            // Add custom extensions if provided
            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Adding ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`);
                this.context.addCustomExtensions(customFileExtensions);
            }

            // Add custom ignore patterns if provided (before loading file-based patterns)
            if (customIgnorePatterns.length > 0) {
                console.log(`[IGNORE-PATTERNS] Adding ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`);
                this.context.addCustomIgnorePatterns(customIgnorePatterns);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Ensure background sync is active when starting to index
            if (this.syncManager && !this.syncManager.isBackgroundSyncActive()) {
                console.log('[INDEX] Background sync is not active. Restarting for new codebase indexing.');
                this.syncManager.startBackgroundSync();
            }

            // Start background indexing - now safe to proceed
            this.startBackgroundIndexing(absolutePath, forceReindex, splitterType);

            const pathResolutionInfo = pathInfo !== codebasePath
                ? `\n📍 Path resolution: ${pathInfo}`
                : '';

            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `🚀 **Indexing Started Successfully**

📁 Codebase: ${absolutePath}
🔧 Splitter: ${splitterType.toUpperCase()}
⚡ Mode: Background indexing (you can continue working)

${pathResolutionInfo}${extensionInfo}${ignoreInfo}

💡 **What happens next**:
- Indexing runs automatically in the background
- You can start searching immediately (results improve as indexing progresses)
- Large codebases may take a few minutes to complete

Ready to explore your codebase!`
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
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            // Use the existing Context instance for indexing.
            let contextForThisTask = this.context;
            if (splitterType !== 'ast') {
                console.warn(`[BACKGROUND-INDEX] Non-AST splitter '${splitterType}' requested; falling back to AST splitter`);
            }

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            await this.context.getLoadedIgnorePatterns(absolutePath);

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            const { FileSynchronizer } = await import("@zilliz/claude-context-core");
            const ignorePatterns = this.context.getIgnorePatterns() || [];
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns);
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.getPreparedCollection(absolutePath);
            const collectionName = this.context.getCollectionName(absolutePath);
            this.context.setSynchronizer(collectionName, synchronizer);
            if (contextForThisTask !== this.context) {
                contextForThisTask.setSynchronizer(collectionName, synchronizer);
            }

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} with dimension: ${embeddingProvider.getDimension()}`);

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await contextForThisTask.indexCodebase(absolutePath, (progress: any) => {
                // Update progress in snapshot manager using new method
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            });
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats);
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            // Get the last attempted progress
            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            const errorMessage = error.message || String(error);
            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress);
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10, extensionFilter } = args;
        const resultLimit = limit || 10;

        try {
            // 🕒 性能追踪: 总体搜索开始
            const totalSearchStartTime = Date.now();
            console.log(`[SEARCH-PERF] 🚀 Starting search for query: "${query}"`);
            
            // Sync indexed codebases from cloud first
            const syncStartTime = Date.now();
            await this.syncIndexedCodebasesFromCloud();
            const syncDuration = ((Date.now() - syncStartTime) / 1000).toFixed(2);
            console.log(`[SEARCH-PERF] ✅ Cloud sync completed in ${syncDuration}s`);

            // Smart path resolution
            const { resolvedPath: absolutePath, pathInfo } = this.smartPathResolution(codebasePath, 'search');

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `🔍 **Path Not Found**

I couldn't find the codebase at: ${absolutePath}

**Path resolution attempted**: ${pathInfo}

💡 **Suggestions**:
- Check if the project directory exists
- Try using an absolute path (e.g., /Users/yourname/project)
- Verify the project name spelling
- Use a parent directory if searching within a subdirectory

**Example**: Use the full project path like "/Users/yourname/my-project" instead of just "my-project"`
                    }],
                    isError: false // Changed to false to provide helpful feedback
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

            // Check if this codebase is indexed or being indexed (including parent directories)
            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            const indexingCodebases = this.snapshotManager.getIndexingCodebases();

            const isIndexed = isPathIndexedOrNested(absolutePath, indexedCodebases);
            const isIndexing = isPathIndexedOrNested(absolutePath, indexingCodebases);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `💡 **Suggestion**: This codebase needs to be indexed first for efficient searching.

**Recommended action**: Index this codebase now:
- Use the index_codebase tool with path: '${absolutePath}'
- Indexing runs in background, you can continue working

**Alternative**: You can still explore the codebase using file system tools, but semantic search won't be available until indexing completes.

**Benefits of indexing**:
- Find code by natural language queries
- Discover related code across the entire codebase
- Get intelligent suggestions and context

Ready to index this codebase?`
                    }]
                };
            }

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            const actualIndexedPath = this.findIndexedParentPath(absolutePath);
            const searchTargetPath = actualIndexedPath || absolutePath;

            if (isIndexing) {
                if (actualIndexedPath && actualIndexedPath !== absolutePath) {
                    indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is being indexed through parent directory '${actualIndexedPath}'. Search results may be incomplete until indexing completes.`;
                } else {
                    indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
                }
            }

            console.log(`[SEARCH] Searching in codebase: ${absolutePath}`);
            console.log(`[SEARCH] Actual search target (indexed directory): ${searchTargetPath}`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // Log embedding provider information before search
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[SEARCH] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} for search`);
            console.log(`[SEARCH] 🔍 Generating embeddings for query using ${embeddingProvider.getProvider()}...`);

            // Build filter expression from extensionFilter list
            let filterExpr: string | undefined = undefined;
            if (Array.isArray(extensionFilter) && extensionFilter.length > 0) {
                const cleaned = extensionFilter
                    .filter((v: any) => typeof v === 'string')
                    .map((v: string) => v.trim())
                    .filter((v: string) => v.length > 0);
                const invalid = cleaned.filter((e: string) => !(e.startsWith('.') && e.length > 1 && !/\s/.test(e)));
                if (invalid.length > 0) {
                    return {
                        content: [{ type: 'text', text: `Error: Invalid file extensions in extensionFilter: ${JSON.stringify(invalid)}. Use proper extensions like '.ts', '.py'.` }],
                        isError: true
                    };
                }
                const quoted = cleaned.map((e: string) => `'${e}'`).join(', ');
                filterExpr = `fileExtension in [${quoted}]`;
            }

            // Search in the actual indexed codebase (may be parent directory)
            const searchStartTime = Date.now();
            const searchResults = await this.context.semanticSearch(
                searchTargetPath,
                query,
                Math.min(resultLimit, 50),
                0.3,
                filterExpr
            );
            const searchDuration = ((Date.now() - searchStartTime) / 1000).toFixed(2);
            console.log(`[SEARCH-PERF] ✅ Vector search completed in ${searchDuration}s`);

            console.log(`[SEARCH] ✅ Search completed! Found ${searchResults.length} results using ${embeddingProvider.getProvider()} embeddings`);

            if (searchResults.length === 0) {
                let noResultsMessage = `No results found for query: "${query}" in codebase '${absolutePath}'`;
                if (actualIndexedPath && actualIndexedPath !== absolutePath) {
                    noResultsMessage += ` (searched through indexed parent directory '${actualIndexedPath}')`;
                }
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: This codebase is still being indexed. Try searching again after indexing completes, or the query may not match any indexed content.`;
                }
                return {
                    content: [{
                        type: "text",
                        text: noResultsMessage
                    }]
                };
            }

            // Format results in a more structured way for better LLM understanding
            const searchSummary = {
                query: query,
                codebase: absolutePath,
                actual_search_path: actualIndexedPath || absolutePath,
                total_results: searchResults.length,
                indexing_status: isIndexing ? 'In Progress' : 'Complete',
                is_parent_search: actualIndexedPath && actualIndexedPath !== absolutePath
            };

            // Format individual results with clear structure
            const formattedResults = searchResults.map((result: any, index: number) => {
                const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                const context = truncateContent(result.content, 5000);
                const codebaseInfo = path.basename(searchTargetPath);
                const relevance = Math.round((result.score || 0) * 100);

                return {
                    rank: index + 1,
                    file: result.relativePath,
                    location: location,
                    language: result.language,
                    relevance: `${relevance}%`,
                    codebase: codebaseInfo,
                    content: context
                };
            });

            // Create a structured response that's easy for LLM to parse
            let resultMessage = `🔍 **Search Results Summary**\n`;
            resultMessage += `• Query: "${query}"\n`;
            resultMessage += `• Codebase: ${absolutePath}\n`;
            resultMessage += `• Results: ${searchResults.length} matches\n`;
            resultMessage += `• Status: ${isIndexing ? '⏳ Indexing in progress' : '✅ Fully indexed'}\n`;
            
            if (searchSummary.is_parent_search) {
                resultMessage += `• Search scope: Parent directory '${actualIndexedPath}'\n`;
            }
            
            resultMessage += `\n📋 **Results**:\n\n`;

            // Add structured results
            formattedResults.forEach((result) => {
                resultMessage += `${result.rank}. **${result.file}** (${result.language})\n`;
                resultMessage += `   📍 Location: ${result.location}\n`;
                resultMessage += `   🎯 Relevance: ${result.relevance}\n`;
                resultMessage += `   📄 Code:\n\`\`\`${result.language}\n${result.content}\n\`\`\`\n\n`;
            });

            if (isIndexing) {
                resultMessage += `💡 **Note**: Codebase is still indexing. Results may improve as more files are processed.\n`;
            }
            
            // 🕒 性能追踪: 总体搜索完成
            const totalDuration = ((Date.now() - totalSearchStartTime) / 1000).toFixed(2);
            console.log(`[SEARCH-PERF] 🏁 Total search completed in ${totalDuration}s`);
            console.log(`[SEARCH-PERF] 📊 Breakdown: Sync=${syncDuration}s, Search=${searchDuration}s, Other=${(parseFloat(totalDuration) - parseFloat(syncDuration) - parseFloat(searchDuration)).toFixed(2)}s`);

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

            // Check if this codebase is indexed or being indexed (including parent directories)
            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            const indexingCodebases = this.snapshotManager.getIndexingCodebases();

            const isIndexed = isPathIndexedOrNested(absolutePath, indexedCodebases);
            const isIndexing = isPathIndexedOrNested(absolutePath, indexingCodebases);

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

            try {
                await this.context.clearIndex(absolutePath);
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

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;
            
            // ✅ 性能优化: 清除缓存，因为云端状态已改变
            this.cloudSyncCache = null;
            console.log(`[CLEAR] 🗑️ Cleared cloud sync cache due to index change`);

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            // Check if we should stop background sync (optimization: no need to run sync if no codebases)
            if (remainingIndexed === 0 && remainingIndexing === 0 && this.syncManager) {
                if (this.syncManager.isBackgroundSyncActive()) {
                    console.log('[CLEAR] No codebases remaining. Stopping background sync for efficiency.');
                    this.syncManager.stopBackgroundSync();
                    resultText += '\n\n💡 Background sync stopped (no codebases to monitor)';
                }
            }

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
            // Force absolute path resolution
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

            // Check indexing status using new status system (including parent directories)
            let status = this.snapshotManager.getCodebaseStatus(absolutePath);
            let info = this.snapshotManager.getCodebaseInfo(absolutePath);

            // If not found directly, check if this is a subdirectory of an indexed codebase
            if (status === 'not_found') {
                const indexedCodebases = this.snapshotManager.getIndexedCodebases();
                const indexingCodebases = this.snapshotManager.getIndexingCodebases();

                for (const indexedPath of indexedCodebases) {
                    if (isPathIndexedOrNested(absolutePath, [indexedPath])) {
                        status = 'indexed';
                        info = this.snapshotManager.getCodebaseInfo(indexedPath);
                        console.log(`[STATUS] Found parent indexed directory: ${indexedPath} for subdirectory: ${absolutePath}`);
                        break;
                    }
                }

                if (status === 'not_found') {
                    for (const indexingPath of indexingCodebases) {
                        if (isPathIndexedOrNested(absolutePath, [indexingPath])) {
                            status = 'indexing';
                            info = this.snapshotManager.getCodebaseInfo(indexingPath);
                            console.log(`[STATUS] Found parent indexing directory: ${indexingPath} for subdirectory: ${absolutePath}`);
                            break;
                        }
                    }
                }
            }

            let statusMessage = '';

            switch (status) {
                case 'indexed':
                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as any;
                        const isParentIndexed = info && this.snapshotManager.getCodebaseStatus(absolutePath) === 'not_found';
                        const actualIndexedPath = this.findIndexedParentPath(absolutePath);

                        if (isParentIndexed && actualIndexedPath) {
                            statusMessage = `✅ Codebase '${absolutePath}' is searchable through parent directory '${actualIndexedPath}'.`;
                        } else {
                            statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                        }

                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                    }
                    break;

                case 'indexing':
                    if (info && 'indexingPercentage' in info) {
                        const indexingInfo = info as any;
                        const progressPercentage = indexingInfo.indexingPercentage || 0;
                        const actualIndexPath = this.findIndexedParentPath(absolutePath);
                        const isParentIndexing = actualIndexPath && actualIndexPath !== absolutePath;

                        if (isParentIndexing) {
                            statusMessage = `🔄 Codebase '${absolutePath}' is being indexed through parent directory '${actualIndexPath}'. Progress: ${progressPercentage.toFixed(1)}%`;
                        } else {
                            statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;
                        }

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage += ' (Preparing and scanning files...)';
                        } else if (progressPercentage < 100) {
                            statusMessage += ' (Processing files and generating embeddings...)';
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed.`;
                    }
                    break;

                case 'indexfailed':
                    if (info && 'errorMessage' in info) {
                        const failedInfo = info as any;
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed.`;
                        statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n💡 You can retry indexing by running the index_codebase command again.`;
                    } else {
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed. You can retry indexing.`;
                    }
                    break;

                case 'not_found':
                default:
                    statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Please use the index_codebase tool to index it first.`;
                    break;
            }

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            return {
                content: [{
                    type: "text",
                    text: statusMessage + pathInfo
                }]
            };
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

    /**
     * Handle text search - high-performance grep alternative
     */
    public async handleTextSearch(args: any) {
        const {
            path: searchPath,
            pattern,
            caseSensitive = false,
            isRegex = false,
            filePattern,
            maxResults = 100,
            contextLines = 2,
            respectGitignore = true
        } = args;

        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(searchPath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${searchPath}'`
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

            console.log(`[TEXT-SEARCH] Starting text search in: ${absolutePath}`);
            console.log(`[TEXT-SEARCH] Pattern: "${pattern}"`);
            console.log(`[TEXT-SEARCH] Case sensitive: ${caseSensitive}`);
            console.log(`[TEXT-SEARCH] Is regex: ${isRegex}`);
            console.log(`[TEXT-SEARCH] File pattern: ${filePattern || 'all files'}`);
            console.log(`[TEXT-SEARCH] Max results: ${maxResults}`);
            console.log(`[TEXT-SEARCH] Respect .gitignore: ${respectGitignore}`);

            const searcher = new TextSearcher();
            const options: TextSearchOptions = {
                pattern,
                caseSensitive,
                isRegex,
                filePattern,
                maxResults,
                contextLines,
                respectGitignore
            };

            const result = await searcher.search(absolutePath, options);

            console.log(`[TEXT-SEARCH] ✅ Search completed in ${result.duration}ms`);
            console.log(`[TEXT-SEARCH] Found ${result.totalMatches} matches in ${result.filesSearched} files`);

            if (result.totalMatches === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `No matches found for pattern "${pattern}" in '${absolutePath}'\n\nSearched ${result.filesSearched} files in ${result.duration}ms.`
                    }]
                };
            }

            // Format results
            const formattedMatches = result.matches.map((match, index) => {
                let output = `${index + 1}. ${match.file}:${match.line}:${match.column}\n`;

                // Add context
                if (match.beforeContext.length > 0) {
                    match.beforeContext.forEach((line, i) => {
                        const lineNum = match.line - match.beforeContext.length + i;
                        output += `   ${lineNum} | ${line}\n`;
                    });
                }

                // Add matched line (highlighted)
                output += `=> ${match.line} | ${match.matchText}\n`;

                if (match.afterContext.length > 0) {
                    match.afterContext.forEach((line, i) => {
                        const lineNum = match.line + i + 1;
                        output += `   ${lineNum} | ${line}\n`;
                    });
                }

                return output;
            }).join('\n');

            const pathInfo = searchPath !== absolutePath
                ? `\nNote: Input path '${searchPath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const limitInfo = result.totalMatches >= maxResults
                ? `\n\n⚠️  Reached maximum result limit (${maxResults}). There may be more matches.`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `Found ${result.totalMatches} match(es) for "${pattern}" in ${result.filesSearched} file(s) (${result.duration}ms)${pathInfo}${limitInfo}\n\n${formattedMatches}`
                }]
            };

        } catch (error: any) {
            console.error('[TEXT-SEARCH] Error during text search:', error);
            return {
                content: [{
                    type: "text",
                    text: `Error during text search: ${error.message || error}`
                }],
                isError: true
            };
        }
    }
}
