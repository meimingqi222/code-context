import {
    Splitter,
    CodeChunk,
    AstCodeSplitter
} from './splitter';
import {
    Embedding,
    EmbeddingVector,
    OpenAIEmbedding
} from './embedding';
import {
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult
} from './vectordb';
import { SemanticSearchResult } from './types';
import { envManager } from './utils/env-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileSynchronizer } from './sync/synchronizer';

const DEFAULT_SUPPORTED_EXTENSIONS = [
    // Programming languages
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.scala', '.m', '.mm',
    // Text and markup files
    '.md', '.markdown', '.ipynb',
    // '.txt',  '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
    // '.css', '.scss', '.less', '.sql', '.sh', '.bash', '.env'
];

const DEFAULT_IGNORE_PATTERNS = [
    // Common build output and dependency directories
    'node_modules/**',
    'dist/**',
    'build/**',
    'out/**',
    'target/**',
    'coverage/**',
    '.nyc_output/**',

    // IDE and editor files
    '.vscode/**',
    '.idea/**',
    '*.swp',
    '*.swo',

    // Version control
    '.git/**',
    '.svn/**',
    '.hg/**',

    // Cache directories
    '.cache/**',
    '__pycache__/**',
    '.pytest_cache/**',

    // Logs and temporary files
    'logs/**',
    'tmp/**',
    'temp/**',
    '*.log',

    // Environment and config files
    '.env',
    '.env.*',
    '*.local',

    // Minified and bundled files
    '*.min.js',
    '*.min.css',
    '*.min.map',
    '*.bundle.js',
    '*.bundle.css',
    '*.chunk.js',
    '*.vendor.js',
    '*.polyfills.js',
    '*.runtime.js',
    '*.map', // source map files
    'node_modules', '.git', '.svn', '.hg', 'build', 'dist', 'out',
    'target', '.vscode', '.idea', '__pycache__', '.pytest_cache',
    'coverage', '.nyc_output', 'logs', 'tmp', 'temp'
];

export interface ContextConfig {
    embedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
}

export class Context {
    private embedding: Embedding;
    private vectorDatabase: VectorDatabase;
    private codeSplitter: Splitter;
    private supportedExtensions: string[];
    private ignorePatterns: string[];
    private synchronizers = new Map<string, FileSynchronizer>();

    constructor(config: ContextConfig = {}) {
        // Initialize services
        this.embedding = config.embedding || new OpenAIEmbedding({
            apiKey: envManager.get('OPENAI_API_KEY') || 'your-openai-api-key',
            model: 'text-embedding-3-small',
            ...(envManager.get('OPENAI_BASE_URL') && { baseURL: envManager.get('OPENAI_BASE_URL') })
        });

        if (!config.vectorDatabase) {
            throw new Error('VectorDatabase is required. Please provide a vectorDatabase instance in the config.');
        }
        this.vectorDatabase = config.vectorDatabase;

        this.codeSplitter = config.codeSplitter || new AstCodeSplitter(2500, 300);

        // Load custom extensions from environment variables
        const envCustomExtensions = this.getCustomExtensionsFromEnv();

        // Combine default extensions with config extensions and env extensions
        const allSupportedExtensions = [
            ...DEFAULT_SUPPORTED_EXTENSIONS,
            ...(config.supportedExtensions || []),
            ...(config.customExtensions || []),
            ...envCustomExtensions
        ];
        // Remove duplicates
        this.supportedExtensions = [...new Set(allSupportedExtensions)];

        // Load custom ignore patterns from environment variables  
        const envCustomIgnorePatterns = this.getCustomIgnorePatternsFromEnv();

        // Start with default ignore patterns
        const allIgnorePatterns = [
            ...DEFAULT_IGNORE_PATTERNS,
            ...(config.ignorePatterns || []),
            ...(config.customIgnorePatterns || []),
            ...envCustomIgnorePatterns
        ];
        // Remove duplicates
        this.ignorePatterns = [...new Set(allIgnorePatterns)];

        console.log(`[Context] 🔧 Initialized with ${this.supportedExtensions.length} supported extensions and ${this.ignorePatterns.length} ignore patterns`);
        if (envCustomExtensions.length > 0) {
            console.log(`[Context] 📎 Loaded ${envCustomExtensions.length} custom extensions from environment: ${envCustomExtensions.join(', ')}`);
        }
        if (envCustomIgnorePatterns.length > 0) {
            console.log(`[Context] 🚫 Loaded ${envCustomIgnorePatterns.length} custom ignore patterns from environment: ${envCustomIgnorePatterns.join(', ')}`);
        }
    }

    /**
     * Get embedding instance
     */
    getEmbedding(): Embedding {
        return this.embedding;
    }

    /**
     * Get vector database instance
     */
    getVectorDatabase(): VectorDatabase {
        return this.vectorDatabase;
    }

    /**
     * Get code splitter instance
     */
    getCodeSplitter(): Splitter {
        return this.codeSplitter;
    }

    /**
     * Get supported extensions
     */
    getSupportedExtensions(): string[] {
        return [...this.supportedExtensions];
    }

    /**
     * Get ignore patterns
     */
    getIgnorePatterns(): string[] {
        return [...this.ignorePatterns];
    }

    /**
     * Get synchronizers map
     */
    getSynchronizers(): Map<string, FileSynchronizer> {
        return new Map(this.synchronizers);
    }

    /**
     * Set synchronizer for a collection
     */
    setSynchronizer(collectionName: string, synchronizer: FileSynchronizer): void {
        this.synchronizers.set(collectionName, synchronizer);
    }

    /**
     * Public wrapper for loadIgnorePatterns private method
     */
    async getLoadedIgnorePatterns(codebasePath: string): Promise<void> {
        return this.loadIgnorePatterns(codebasePath);
    }

    /**
     * Public wrapper for prepareCollection private method
     */
    async getPreparedCollection(codebasePath: string): Promise<void> {
        return this.prepareCollection(codebasePath);
    }

    /**
     * Get isHybrid setting from environment variable with default true
     */
    private getIsHybrid(): boolean {
        const isHybridEnv = envManager.get('HYBRID_MODE');
        if (isHybridEnv === undefined || isHybridEnv === null) {
            return true; // Default to true
        }
        return isHybridEnv.toLowerCase() === 'true';
    }

    /**
     * Generate collection name based on codebase path and hybrid mode
     */
    public getCollectionName(codebasePath: string): string {
        const isHybrid = this.getIsHybrid();
        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        const prefix = isHybrid === true ? 'hybrid_code_chunks' : 'code_chunks';
        return `${prefix}_${hash.substring(0, 8)}`;
    }

    /**
     * Index a codebase for semantic search with enhanced progress monitoring
     * @param codebasePath Codebase root path
     * @param progressCallback Optional progress callback function with detailed metrics
     * @param forceReindex Whether to recreate the collection even if it exists
     * @returns Indexing statistics
     */
    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number; throughput?: number; eta?: number }) => void,
        forceReindex: boolean = false
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        const startTime = Date.now();
        
        // Performance monitoring is now handled directly by components
        
        console.log(`[Context] 🚀 Starting optimized indexing with ${searchType}: ${codebasePath}`);
        console.log(`[Context] 🎯 System info: ${this.getSystemMemory()}MB total memory, ${require('os').cpus().length} CPU cores`);

        // Enhanced progress tracking
        const progressTracker = {
            startTime,
            filesProcessed: 0,
            chunksProcessed: 0,
            lastUpdate: startTime,
            lastFilesProcessed: 0,
            lastChunksProcessed: 0
        };

        // 1. Load ignore patterns from various ignore files
        progressCallback?.({ phase: 'Loading patterns...', current: 0, total: 100, percentage: 0 });
        await this.loadIgnorePatterns(codebasePath);

        // 2. Check and prepare vector collection
        progressCallback?.({ phase: 'Preparing collection...', current: 5, total: 100, percentage: 5 });
        console.log(`[Context] 🔧 Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        await this.prepareCollection(codebasePath, forceReindex);

        // 3. Recursively traverse codebase to get all supported files
        progressCallback?.({ phase: 'Scanning files...', current: 10, total: 100, percentage: 10 });
        const scanStart = Date.now();
        const codeFiles = await this.getCodeFiles(codebasePath);
        const scanTime = Date.now() - scanStart;
        
        console.log(`[Context] 📁 Found ${codeFiles.length} code files in ${scanTime}ms`);

        if (codeFiles.length === 0) {
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return { indexedFiles: 0, totalChunks: 0, status: 'completed' };
        }

        // Enhanced progress callback with performance metrics
        const enhancedProgressCallback = (filePath: string, fileIndex: number, totalFiles: number, chunksSoFar: number) => {
            const currentTime = Date.now();
            const elapsed = (currentTime - progressTracker.startTime) / 1000; // seconds
            
            progressTracker.filesProcessed = fileIndex;
            progressTracker.chunksProcessed = chunksSoFar;
            
            // Calculate throughput every 5 seconds
            let throughput = undefined;
            let eta = undefined;
            
            if (currentTime - progressTracker.lastUpdate > 5000) {
                const timeDiff = (currentTime - progressTracker.lastUpdate) / 1000;
                const filesDiff = fileIndex - progressTracker.lastFilesProcessed;
                const chunksDiff = chunksSoFar - progressTracker.lastChunksProcessed;
                
                throughput = chunksDiff / timeDiff; // chunks per second
                eta = throughput > 0 ? (totalFiles - fileIndex) / throughput : undefined;
                
                progressTracker.lastUpdate = currentTime;
                progressTracker.lastFilesProcessed = fileIndex;
                progressTracker.lastChunksProcessed = chunksSoFar;
            }

            // Calculate progress percentage (15% for prep, 85% for processing)
            const progressPercentage = 15 + (fileIndex / totalFiles) * 85;

            if (fileIndex % 25 === 0 || throughput) { // Log every 25 files or when throughput is calculated
                console.log(`[Context] 📊 Progress: ${fileIndex}/${totalFiles} files (${Math.round(progressPercentage)}%), ${chunksSoFar} chunks, ${throughput ? `${throughput.toFixed(1)} chunks/sec` : 'calculating...'}`);
            }

            progressCallback?.({
                phase: `Processing files (${fileIndex}/${totalFiles})...`,
                current: fileIndex,
                total: totalFiles,
                percentage: Math.round(progressPercentage),
                throughput: throughput,
                eta: eta
            });
        };

        // 4. Process files with enhanced tracking
        const result = await this.processFileList(
            codeFiles,
            codebasePath,
            enhancedProgressCallback
        );

        // 5. Flush any remaining batched documents to database
        console.log(`[Context] 📦 Flushing remaining batched documents...`);
        const milvusDB = this.vectorDatabase as any;
        if (typeof milvusDB.flushInsertQueue === 'function') {
            await milvusDB.flushInsertQueue();
        }

        const totalTime = (Date.now() - startTime) / 1000;
        const avgThroughput = result.totalChunks / totalTime;
        
        console.log(`[Context] ✅ Optimized indexing completed!`);
        console.log(`[Context] 📊 Final stats: ${result.processedFiles} files, ${result.totalChunks} chunks, ${avgThroughput.toFixed(2)} chunks/sec, ${totalTime.toFixed(1)}s total`);

        // Performance metrics are now handled directly by components

        progressCallback?.({
            phase: 'Indexing complete!',
            current: result.processedFiles,
            total: codeFiles.length,
            percentage: 100,
            throughput: avgThroughput
        });

        return {
            indexedFiles: result.processedFiles,
            totalChunks: result.totalChunks,
            status: result.status
        };
    }

    async reindexByChange(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<{ added: number, removed: number, modified: number }> {
        const collectionName = this.getCollectionName(codebasePath);
        const synchronizer = this.synchronizers.get(collectionName);

        if (!synchronizer) {
            // Load project-specific ignore patterns before creating FileSynchronizer
            await this.loadIgnorePatterns(codebasePath);

            // To be safe, let's initialize if it's not there.
            const newSynchronizer = new FileSynchronizer(codebasePath, this.ignorePatterns);
            await newSynchronizer.initialize();
            this.synchronizers.set(collectionName, newSynchronizer);
        }

        const currentSynchronizer = this.synchronizers.get(collectionName)!;

        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const { added, removed, modified } = await currentSynchronizer.checkForChanges();
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            return { added: 0, removed: 0, modified: 0 };
        }

        console.log(`[Context] 🔄 Found changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`);

        let processedChanges = 0;
        const updateProgress = (phase: string) => {
            processedChanges++;
            const percentage = Math.round((processedChanges / (removed.length + modified.length + added.length)) * 100);
            progressCallback?.({ phase, current: processedChanges, total: totalChanges, percentage });
        };

        // Handle removed files
        for (const file of removed) {
            await this.deleteFileChunks(collectionName, file);
            updateProgress(`Removed ${file}`);
        }

        // Handle modified files
        for (const file of modified) {
            await this.deleteFileChunks(collectionName, file);
            updateProgress(`Deleted old chunks for ${file}`);
        }

        // Handle added and modified files
        const filesToIndex = [...added, ...modified].map(f => path.join(codebasePath, f));

        if (filesToIndex.length > 0) {
            await this.processFileList(
                filesToIndex,
                codebasePath,
                (filePath, fileIndex, totalFiles) => {
                    updateProgress(`Indexed ${filePath} (${fileIndex}/${totalFiles})`);
                }
            );
        }

        // Flush any remaining batched documents
        const milvusDB = this.vectorDatabase as any;
        if (typeof milvusDB.flushInsertQueue === 'function') {
            await milvusDB.flushInsertQueue();
        }

        console.log(`[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`);
        progressCallback?.({ phase: 'Re-indexing complete!', current: totalChanges, total: totalChanges, percentage: 100 });

        return { added: added.length, removed: removed.length, modified: modified.length };
    }

    private async deleteFileChunks(collectionName: string, relativePath: string): Promise<void> {
        // Escape backslashes for Milvus query expression (Windows path compatibility)
        const escapedPath = relativePath.replace(/\\/g, '\\\\');
        const results = await this.vectorDatabase.query(
            collectionName,
            `relativePath == "${escapedPath}"`,
            ['id']
        );

        if (results.length > 0) {
            const ids = results.map(r => r.id as string).filter(id => id);
            if (ids.length > 0) {
                await this.vectorDatabase.delete(collectionName, ids);
                console.log(`[Context] Deleted ${ids.length} chunks for file ${relativePath}`);
            }
        }
    }

    /**
     * Semantic search with unified implementation
     * @param codebasePath Codebase path to search in
     * @param query Search query
     * @param topK Number of results to return
     * @param threshold Similarity threshold
     */
    async semanticSearch(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string): Promise<SemanticSearchResult[]> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath}`);

        const collectionName = this.getCollectionName(codebasePath);
        console.log(`[Context] 🔍 Using collection: ${collectionName}`);

        // Check if collection exists and has data
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            console.log(`[Context] ⚠️  Collection '${collectionName}' does not exist. Please index the codebase first.`);
            return [];
        }

        if (isHybrid === true) {
            // ✅ 性能优化: 并行化 embedding 生成和 collection 检查
            console.log(`[Context] ⚡ Parallel execution: generating embeddings + checking collection status...`);
            const embeddingStartTime = Date.now();
            
            const [queryEmbedding, _] = await Promise.all([
                // 1. Generate query vector (parallel)
                this.embedding.embed(query),
                // 2. Check collection stats (parallel)
                (async () => {
                    try {
                        const stats = await this.vectorDatabase.query(collectionName, '', ['id'], 1);
                        console.log(`[Context] 🔍 Collection '${collectionName}' exists and appears to have data`);
                    } catch (error) {
                        console.log(`[Context] ⚠️  Collection '${collectionName}' exists but may be empty or not properly indexed:`, error);
                    }
                })()
            ]);
            
            const embeddingDuration = ((Date.now() - embeddingStartTime) / 1000).toFixed(2);
            console.log(`[Context] ✅ Embedding generation completed in ${embeddingDuration}s`);
            console.log(`[Context] 🔍 Generated embedding vector with dimension: ${queryEmbedding.vector.length}`);
            console.log(`[Context] 🔍 First 5 embedding values: [${queryEmbedding.vector.slice(0, 5).join(', ')}]`);

            // 2. Prepare hybrid search requests
            const searchRequests: HybridSearchRequest[] = [
                {
                    data: queryEmbedding.vector,
                    anns_field: "vector",
                    param: { "nprobe": 10 },
                    limit: topK
                },
                {
                    data: query,
                    anns_field: "sparse_vector",
                    param: { "drop_ratio_search": 0.2 },
                    limit: topK
                }
            ];

            console.log(`[Context] 🔍 Search request 1 (dense): anns_field="${searchRequests[0].anns_field}", vector_dim=${queryEmbedding.vector.length}, limit=${searchRequests[0].limit}`);
            console.log(`[Context] 🔍 Search request 2 (sparse): anns_field="${searchRequests[1].anns_field}", query_text="${query}", limit=${searchRequests[1].limit}`);

            // 3. Execute hybrid search
            console.log(`[Context] 🔍 Executing hybrid search with RRF reranking...`);
            const searchResults: HybridSearchResult[] = await this.vectorDatabase.hybridSearch(
                collectionName,
                searchRequests,
                {
                    rerank: {
                        strategy: 'rrf',
                        params: { k: 100 }
                    },
                    limit: topK,
                    filterExpr
                }
            );

            console.log(`[Context] 🔍 Raw search results count: ${searchResults.length}`);

            // 4. Convert to semantic search result format
            const results: SemanticSearchResult[] = searchResults.map(result => ({
                content: result.document.content,
                relativePath: result.document.relativePath,
                startLine: result.document.startLine,
                endLine: result.document.endLine,
                language: result.document.metadata.language || 'unknown',
                score: result.score
            }));

            console.log(`[Context] ✅ Found ${results.length} relevant hybrid results`);
            if (results.length > 0) {
                console.log(`[Context] 🔍 Top result score: ${results[0].score}, path: ${results[0].relativePath}`);
            }

            return results;
        } else {
            // Regular semantic search
            // 1. Generate query vector
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);

            // 2. Search in vector database
            const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
                collectionName,
                queryEmbedding.vector,
                { topK, threshold, filterExpr }
            );

            // 3. Convert to semantic search result format
            const results: SemanticSearchResult[] = searchResults.map(result => ({
                content: result.document.content,
                relativePath: result.document.relativePath,
                startLine: result.document.startLine,
                endLine: result.document.endLine,
                language: result.document.metadata.language || 'unknown',
                score: result.score
            }));

            console.log(`[Context] ✅ Found ${results.length} relevant results`);
            return results;
        }
    }

    /**
     * Check if index exists for codebase
     * @param codebasePath Codebase path to check
     * @returns Whether index exists
     */
    async hasIndex(codebasePath: string): Promise<boolean> {
        const collectionName = this.getCollectionName(codebasePath);
        return await this.vectorDatabase.hasCollection(collectionName);
    }

    /**
     * Clear index
     * @param codebasePath Codebase path to clear index for
     * @param progressCallback Optional progress callback function
     */
    async clearIndex(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<void> {
        console.log(`[Context] 🧹 Cleaning index data for ${codebasePath}...`);

        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });

        const collectionName = this.getCollectionName(codebasePath);
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });

        if (collectionExists) {
            await this.vectorDatabase.dropCollection(collectionName);
        }

        // Delete snapshot file
        await FileSynchronizer.deleteSnapshot(codebasePath);

        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
        console.log('[Context] ✅ Index data cleaned');
    }

    /**
     * Update ignore patterns (merges with default patterns and existing patterns)
     * @param ignorePatterns Array of ignore patterns to add to defaults
     */
    updateIgnorePatterns(ignorePatterns: string[]): void {
        // Merge with default patterns and any existing custom patterns, avoiding duplicates
        const mergedPatterns = [...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns];
        const uniquePatterns: string[] = [];
        const patternSet = new Set(mergedPatterns);
        patternSet.forEach(pattern => uniquePatterns.push(pattern));
        this.ignorePatterns = uniquePatterns;
        console.log(`[Context] 🚫 Updated ignore patterns: ${ignorePatterns.length} new + ${DEFAULT_IGNORE_PATTERNS.length} default = ${this.ignorePatterns.length} total patterns`);
    }

    /**
     * Add custom ignore patterns (from MCP or other sources) without replacing existing ones
     * @param customPatterns Array of custom ignore patterns to add
     */
    addCustomIgnorePatterns(customPatterns: string[]): void {
        if (customPatterns.length === 0) return;

        // Merge current patterns with new custom patterns, avoiding duplicates
        const mergedPatterns = [...this.ignorePatterns, ...customPatterns];
        const uniquePatterns: string[] = [];
        const patternSet = new Set(mergedPatterns);
        patternSet.forEach(pattern => uniquePatterns.push(pattern));
        this.ignorePatterns = uniquePatterns;
        console.log(`[Context] 🚫 Added ${customPatterns.length} custom ignore patterns. Total: ${this.ignorePatterns.length} patterns`);
    }

    /**
     * Reset ignore patterns to defaults only
     */
    resetIgnorePatternsToDefaults(): void {
        this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
        console.log(`[Context] 🔄 Reset ignore patterns to defaults: ${this.ignorePatterns.length} patterns`);
    }

    /**
     * Update embedding instance
     * @param embedding New embedding instance
     */
    updateEmbedding(embedding: Embedding): void {
        this.embedding = embedding;
        console.log(`[Context] 🔄 Updated embedding provider: ${embedding.getProvider()}`);
    }

    /**
     * Update vector database instance
     * @param vectorDatabase New vector database instance
     */
    updateVectorDatabase(vectorDatabase: VectorDatabase): void {
        this.vectorDatabase = vectorDatabase;
        console.log(`[Context] 🔄 Updated vector database`);
    }

    /**
     * Update splitter instance
     * @param splitter New splitter instance
     */
    updateSplitter(splitter: Splitter): void {
        this.codeSplitter = splitter;
        console.log(`[Context] 🔄 Updated splitter instance`);
    }

    /**
     * Prepare vector collection
     */
    private async prepareCollection(codebasePath: string, forceReindex: boolean = false): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        console.log(`[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        const collectionName = this.getCollectionName(codebasePath);

        // Check if collection already exists
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        if (collectionExists && !forceReindex) {
            console.log(`📋 Collection ${collectionName} already exists, skipping creation`);
            return;
        }

        if (collectionExists && forceReindex) {
            console.log(`[Context] 🗑️  Dropping existing collection ${collectionName} for force reindex...`);
            await this.vectorDatabase.dropCollection(collectionName);
            console.log(`[Context] ✅ Collection ${collectionName} dropped successfully`);
        }

        console.log(`[Context] 🔍 Detecting embedding dimension for ${this.embedding.getProvider()} provider...`);
        const dimension = await this.embedding.detectDimension();
        console.log(`[Context] 📏 Detected dimension: ${dimension} for ${this.embedding.getProvider()}`);
        const dirName = path.basename(codebasePath);

        if (isHybrid === true) {
            await this.vectorDatabase.createHybridCollection(collectionName, dimension, `Hybrid Index for ${dirName}`);
        } else {
            await this.vectorDatabase.createCollection(collectionName, dimension, `Index for ${dirName}`);
        }

        console.log(`[Context] ✅ Collection ${collectionName} created successfully (dimension: ${dimension})`);
    }

    /**
     * Recursively get all code files in the codebase
     */
    private async getCodeFiles(codebasePath: string): Promise<string[]> {
        const files: string[] = [];
        let ignoredDirs = 0;
        let ignoredFiles = 0;
        let unsupportedFiles = 0;
        let totalDirs = 0;

        console.log(`[Context] 📂 Starting file scan in: ${codebasePath}`);
        console.log(`[Context] 🎯 Looking for extensions: ${this.supportedExtensions.slice(0, 10).join(', ')}${this.supportedExtensions.length > 10 ? ` ...and ${this.supportedExtensions.length - 10} more` : ''}`);
        console.log(`[Context] 🚫 Active ignore patterns: ${this.ignorePatterns.length} patterns`);

        const traverseDirectory = async (currentPath: string) => {
            totalDirs++;
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);

                // Check if path matches ignore patterns
                if (this.matchesIgnorePattern(fullPath, codebasePath)) {
                    if (entry.isDirectory()) {
                        ignoredDirs++;
                        if (ignoredDirs <= 5) {
                            console.log(`[Context] ⏭️  Ignoring directory: ${path.relative(codebasePath, fullPath)}`);
                        }
                    } else {
                        ignoredFiles++;
                    }
                    continue;
                }

                if (entry.isDirectory()) {
                    await traverseDirectory(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (this.supportedExtensions.includes(ext)) {
                        files.push(fullPath);
                        if (files.length <= 5) {
                            console.log(`[Context] ✅ Found file: ${path.relative(codebasePath, fullPath)}`);
                        }
                    } else {
                        unsupportedFiles++;
                    }
                }
            }
        };

        await traverseDirectory(codebasePath);
        
        console.log(`[Context] 📊 Scan complete:`);
        console.log(`[Context]   ✅ Found ${files.length} supported code files`);
        console.log(`[Context]   ⏭️  Ignored ${ignoredDirs} directories, ${ignoredFiles} files`);
        console.log(`[Context]   📁 Scanned ${totalDirs} directories`);
        console.log(`[Context]   ❌ Skipped ${unsupportedFiles} files with unsupported extensions`);
        
        if (files.length === 0) {
            console.warn(`[Context] ⚠️  WARNING: No files found! This might indicate:`);
            console.warn(`[Context]      1. All files are being filtered by ignore patterns`);
            console.warn(`[Context]      2. No files with supported extensions exist`);
            console.warn(`[Context]      3. Directory permissions issue`);
            console.warn(`[Context]   First 10 ignore patterns: ${this.ignorePatterns.slice(0, 10).join(', ')}`);
        }
        
        return files;
    }

    /**
     * Get API concurrency setting from environment or calculate based on provider
     */
    private getAPIConcurrency(): number {
        const envConcurrency = envManager.get('API_CONCURRENCY');
        if (envConcurrency) {
            const parsed = parseInt(envConcurrency, 10);
            if (!isNaN(parsed) && parsed > 0) {
                return Math.min(parsed, 10); // Max 10 for safety
            }
        }
        
        // Provider-specific safe concurrency limits
        const provider = this.embedding.getProvider();
        const providerConcurrency = {
            'OpenAI': 5,        // OpenAI: 3000 RPM limit
            'VoyageAI': 3,     // VoyageAI: 300 RPM limit  
            'Gemini': 2,       // Gemini: Conservative
            'Ollama': 10       // Ollama: Local, can handle more
        };
        
        return providerConcurrency[provider as keyof typeof providerConcurrency] || 3;
    }

    /**
     * Get file concurrency setting from environment or calculate based on system
     */
    private getFileConcurrency(): number {
        const envConcurrency = envManager.get('FILE_CONCURRENCY');
        if (envConcurrency) {
            const parsed = parseInt(envConcurrency, 10);
            if (!isNaN(parsed) && parsed > 0) {
                return Math.min(parsed, 50); // Max 50 for safety
            }
        }
        
        // Default: CPU cores * 2, max 20
        const os = require('os');
        const cpuCores = os.cpus().length;
        return Math.min(cpuCores * 2, 20);
    }

    /**
     * Check if concurrent indexing is enabled
     */
    private isConcurrentIndexingEnabled(): boolean {
        const envValue = envManager.get('ENABLE_CONCURRENT_INDEXING');
        if (envValue === undefined || envValue === null) {
            return true; // Enabled by default
        }
        return envValue.toLowerCase() === 'true';
    }

    /**
 * Process a list of files with concurrent processing and streaming chunk processing
 * @param filePaths Array of file paths to process
 * @param codebasePath Base path for the codebase
 * @param onFileProcessed Callback called when each file is processed
 * @returns Object with processed file count and total chunk count
 */
    private async processFileList(
        filePaths: string[],
        codebasePath: string,
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number, chunksSoFar: number) => void
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const isConcurrent = this.isConcurrentIndexingEnabled();
        
        // Dynamic batch size optimization based on embedding provider and system capabilities
        const optimalBatchSize = this.calculateOptimalBatchSize();
        const EMBEDDING_BATCH_SIZE = Math.max(10, optimalBatchSize);
        const CHUNK_LIMIT = 450000;
        const MEMORY_LIMIT_MB = parseInt(envManager.get('MEMORY_LIMIT_MB') || '2048', 10); // Increased from 1.5GB to 2GB
        const FILE_CONCURRENCY = this.getFileConcurrency();
        
        console.log(`[Context] 🔧 Optimized indexing - Batch size: ${EMBEDDING_BATCH_SIZE}, Memory limit: ${MEMORY_LIMIT_MB}MB, File concurrency: ${FILE_CONCURRENCY}`);
        console.log(`[Context] 🚀 Concurrent mode: ${isConcurrent ? 'ENABLED' : 'DISABLED'}`);

        if (isConcurrent) {
            // Use concurrent processing
            return await this.processFileListConcurrent(
                filePaths,
                codebasePath,
                onFileProcessed,
                EMBEDDING_BATCH_SIZE,
                CHUNK_LIMIT,
                MEMORY_LIMIT_MB,
                FILE_CONCURRENCY
            );
        } else {
            // Use legacy serial processing
            return await this.processFileListSerial(
                filePaths,
                codebasePath,
                onFileProcessed,
                EMBEDDING_BATCH_SIZE,
                CHUNK_LIMIT,
                MEMORY_LIMIT_MB
            );
        }
    }

    /**
     * Process files concurrently (new optimized method)
     */
    private async processFileListConcurrent(
        filePaths: string[],
        codebasePath: string,
        onFileProcessed: ((filePath: string, fileIndex: number, totalFiles: number, chunksSoFar: number) => void) | undefined,
        EMBEDDING_BATCH_SIZE: number,
        CHUNK_LIMIT: number,
        MEMORY_LIMIT_MB: number,
        FILE_CONCURRENCY: number
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const API_CONCURRENCY = this.getAPIConcurrency();
        
        let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
        let pendingBuffers: Array<Array<{ chunk: CodeChunk; codebasePath: string }>> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        let batchCount = 0;
        let failedFiles: string[] = [];
        const startTime = Date.now();

        console.log(`[Context] 🚀 Starting concurrent file processing with concurrency: ${FILE_CONCURRENCY}`);
        console.log(`[Context] ⚡ Embedding API concurrency: ${API_CONCURRENCY}`);

        // Process files in concurrent batches
        for (let i = 0; i < filePaths.length && !limitReached; i += FILE_CONCURRENCY) {
            const batch = filePaths.slice(i, i + FILE_CONCURRENCY);
            const batchStartTime = Date.now();
            
            console.log(`[Context] 📦 Processing file batch ${Math.floor(i / FILE_CONCURRENCY) + 1}/${Math.ceil(filePaths.length / FILE_CONCURRENCY)}: ${batch.length} files`);

            // Process batch concurrently
            const fileReadStart = Date.now();
            const results = await Promise.allSettled(
                batch.map(async (filePath) => {
                    try {
                        const content = await fs.promises.readFile(filePath, 'utf-8');
                        const language = this.getLanguageFromExtension(path.extname(filePath));
                        const chunks = await this.codeSplitter.split(content, language, filePath);
                        
                        // Performance logging for large files
                        if (chunks.length > 50) {
                            console.warn(`[Context] ⚠️  File ${path.relative(codebasePath, filePath)} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`);
                        }
                        
                        return { filePath, chunks, success: true };
                    } catch (error) {
                        console.warn(`[Context] ⚠️  Failed to process file ${filePath}: ${error}`);
                        return { filePath, chunks: [], success: false, error };
                    }
                })
            );

            const batchTime = Date.now() - batchStartTime;
            console.log(`[Context] ⏱️  Batch completed in ${batchTime}ms (${(batchTime / batch.length).toFixed(0)}ms/file avg)`);
            
            // File read performance tracking

            // Process results
            for (const result of results) {
                if (result.status === 'fulfilled' && result.value.success) {
                    const { filePath, chunks } = result.value;
                    
                    // Add chunks to buffer
                    for (const chunk of chunks) {
                        chunkBuffer.push({ chunk, codebasePath });
                        totalChunks++;

                        // Check chunk limit
                        if (totalChunks >= CHUNK_LIMIT) {
                            console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
                            limitReached = true;
                            break;
                        }
                    }

                    // Collect buffers for concurrent processing with adaptive threshold
                    const currentMemoryUsage = this.getMemoryUsage();
                    const memoryPressure = currentMemoryUsage / MEMORY_LIMIT_MB;
                    
                    // Adaptive batch size: smaller batches when memory pressure is high
                    const adaptiveBatchSize = memoryPressure > 0.8 
                        ? Math.round(EMBEDDING_BATCH_SIZE * 0.5) 
                        : EMBEDDING_BATCH_SIZE;
                    
                    if (chunkBuffer.length >= adaptiveBatchSize || memoryPressure > 0.9) {
                        // Add current buffer to pending queue
                        pendingBuffers.push([...chunkBuffer]);
                        chunkBuffer = [];
                        batchCount++;
                        
                        // Smoother processing: don't wait until we have full API_CONCURRENCY
                        // Process in smaller batches when memory pressure is high
                        const processingThreshold = memoryPressure > 0.8 
                            ? Math.max(1, Math.floor(API_CONCURRENCY / 2))  // Process more frequently under memory pressure
                            : API_CONCURRENCY;
                        
                        // Process pending buffers when threshold is reached
                        if (pendingBuffers.length >= processingThreshold) {
                            try {
                                const concurrentStart = Date.now();
                                const buffersToProcess = pendingBuffers.splice(0, API_CONCURRENCY);
                                
                                if (memoryPressure > 0.8) {
                                    console.log(`[Context] ⚠️  High memory pressure (${Math.round(memoryPressure * 100)}%), processing ${buffersToProcess.length} batches immediately`);
                                }
                                
                                await this.processChunkBuffersConcurrently(buffersToProcess, API_CONCURRENCY);
                                const concurrentTime = Date.now() - concurrentStart;
                                
                                if (concurrentTime > 60000) {
                                    console.log(`[Context] 🐌 Slow concurrent batch detected (${concurrentTime}ms for ${buffersToProcess.length} batches)`);
                                }
                                
                                // Proactive GC after processing if memory is still high
                                if (this.getMemoryUsage() > MEMORY_LIMIT_MB * 0.7 && global.gc) {
                                    global.gc();
                                    const afterGC = this.getMemoryUsage();
                                    console.log(`[Context] 🗑️  GC triggered: ${currentMemoryUsage}MB -> ${afterGC}MB`);
                                }
                            } catch (error) {
                                const searchType = isHybrid === true ? 'hybrid' : 'regular';
                                console.error(`[Context] ❌ Failed to process concurrent batches for ${searchType}:`, error);
                                throw error; // Re-throw to prevent data loss
                            }
                        }
                    }

                    processedFiles++;
                    onFileProcessed?.(filePath, processedFiles, filePaths.length, totalChunks);
                } else {
                    // Handle failed files
                    if (result.status === 'fulfilled' && !result.value.success) {
                        failedFiles.push(result.value.filePath);
                    } else if (result.status === 'rejected') {
                        console.error(`[Context] ❌ Unexpected error in file processing: ${result.reason}`);
                    }
                }

                if (limitReached) break;
            }

            // Performance metrics
            if (processedFiles % 50 === 0 || (i + FILE_CONCURRENCY >= filePaths.length)) {
                const elapsed = Date.now() - startTime;
                const throughput = (totalChunks / elapsed) * 1000;
                const filesPerSec = (processedFiles / elapsed) * 1000;
                console.log(`[Context] 📊 Progress: ${processedFiles}/${filePaths.length} files (${filesPerSec.toFixed(1)} files/sec), ${totalChunks} chunks (${throughput.toFixed(2)} chunks/sec)`);
            }

            if (limitReached) break;
        }

        // Process remaining chunks and pending buffers
        if (chunkBuffer.length > 0) {
            pendingBuffers.push([...chunkBuffer]);
        }
        
        if (pendingBuffers.length > 0) {
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            console.log(`📝 Processing final ${pendingBuffers.length} batches concurrently for ${searchType}`);
            try {
                await this.processChunkBuffersConcurrently(pendingBuffers, API_CONCURRENCY);
            } catch (error) {
                console.error(`[Context] ❌ Failed to process final concurrent batches for ${searchType}:`, error);
            }
        }

        // Report failed files
        if (failedFiles.length > 0) {
            console.warn(`[Context] ⚠️  Failed to process ${failedFiles.length} files:`);
            failedFiles.slice(0, 5).forEach(f => console.warn(`[Context]   - ${f}`));
            if (failedFiles.length > 5) {
                console.warn(`[Context]   ... and ${failedFiles.length - 5} more`);
            }
        }

        // Final performance summary
        const totalTime = Date.now() - startTime;
        const avgThroughput = (totalChunks / totalTime) * 1000;
        const avgFilesPerSec = (processedFiles / totalTime) * 1000;
        console.log(`[Context] ✅ Concurrent processing completed: ${processedFiles} files (${avgFilesPerSec.toFixed(2)} files/sec), ${batchCount} embedding batches, ${avgThroughput.toFixed(2)} chunks/sec, ${Math.round(totalTime/1000)}s total`);

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed'
        };
    }

    /**
     * Process files serially (legacy method for compatibility)
     */
    private async processFileListSerial(
        filePaths: string[],
        codebasePath: string,
        onFileProcessed: ((filePath: string, fileIndex: number, totalFiles: number, chunksSoFar: number) => void) | undefined,
        EMBEDDING_BATCH_SIZE: number,
        CHUNK_LIMIT: number,
        MEMORY_LIMIT_MB: number
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        
        console.log(`[Context] 🐌 Using serial processing mode (legacy)`);
        
        let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        let batchCount = 0;
        const startTime = Date.now();

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];

            try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromExtension(path.extname(filePath));
                const chunks = await this.codeSplitter.split(content, language, filePath);

                // Performance logging for large files
                if (chunks.length > 50) {
                    console.warn(`[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`);
                } else if (content.length > 100000) {
                    console.log(`📄 Large file ${filePath}: ${Math.round(content.length / 1024)}KB -> ${chunks.length} chunks`);
                }

                // Add chunks to buffer with memory monitoring
                for (const chunk of chunks) {
                    chunkBuffer.push({ chunk, codebasePath });
                    totalChunks++;

                    // Dynamic batch processing with memory awareness
                    if (chunkBuffer.length >= EMBEDDING_BATCH_SIZE || this.getMemoryUsage() > MEMORY_LIMIT_MB) {
                        batchCount++;
                        try {
                            const batchStart = Date.now();
                            await this.processChunkBuffer(chunkBuffer);
                            const batchTime = Date.now() - batchStart;
                            
                            // Adaptive batch size adjustment based on performance
                            if (batchTime > 30000) { // If batch takes > 30s
                                console.log(`[Context] 🐌 Slow batch detected (${batchTime}ms), considering smaller batch size`);
                            }
                        } catch (error) {
                            const searchType = isHybrid === true ? 'hybrid' : 'regular';
                            console.error(`[Context] ❌ Failed to process chunk batch ${batchCount} for ${searchType}:`, error);
                            if (error instanceof Error) {
                                console.error('[Context] Stack trace:', error.stack);
                            }
                        } finally {
                            chunkBuffer = []; // Always clear buffer, even on failure
                            
                            // Force garbage collection if memory is high
                            if (this.getMemoryUsage() > MEMORY_LIMIT_MB * 0.8) {
                                if (global.gc) {
                                    global.gc();
                                }
                            }
                        }
                    }

                    // Check if chunk limit is reached
                    if (totalChunks >= CHUNK_LIMIT) {
                        console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
                        limitReached = true;
                        break; // Exit the inner loop (over chunks)
                    }
                }

                processedFiles++;
                onFileProcessed?.(filePath, i + 1, filePaths.length, totalChunks);

                // Performance metrics
                if (processedFiles % 50 === 0) {
                    const elapsed = Date.now() - startTime;
                    const throughput = (totalChunks / elapsed) * 1000; // chunks per second
                    console.log(`[Context] 📊 Progress: ${processedFiles}/${filePaths.length} files, ${totalChunks} chunks, ${throughput.toFixed(2)} chunks/sec`);
                }

                if (limitReached) {
                    break; // Exit the outer loop (over files)
                }

            } catch (error) {
                console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${error}`);
            }
        }

        // Process any remaining chunks in the buffer
        if (chunkBuffer.length > 0) {
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            console.log(`📝 Processing final batch of ${chunkBuffer.length} chunks for ${searchType}`);
            try {
                await this.processChunkBuffer(chunkBuffer);
            } catch (error) {
                console.error(`[Context] ❌ Failed to process final chunk batch for ${searchType}:`, error);
                if (error instanceof Error) {
                    console.error('[Context] Stack trace:', error.stack);
                }
            }
        }

        // Final performance summary
        const totalTime = Date.now() - startTime;
        const avgThroughput = (totalChunks / totalTime) * 1000;
        console.log(`[Context] ✅ Batch processing completed: ${batchCount} batches, ${avgThroughput.toFixed(2)} avg chunks/sec, ${Math.round(totalTime/1000)}s total`);

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed'
        };
    }

    /**
 * Process accumulated chunk buffer with optional API concurrency
 */
    private async processChunkBuffer(chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>): Promise<void> {
        if (chunkBuffer.length === 0) return;

        // Extract chunks and ensure they all have the same codebasePath
        const chunks = chunkBuffer.map(item => item.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;

        // Estimate tokens (rough estimation: 1 token ≈ 4 characters)
        const estimatedTokens = chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.content.length / 4), 0);

        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 Processing batch of ${chunks.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        await this.processChunkBatch(chunks, codebasePath);
    }

    /**
     * Process multiple chunk buffers concurrently with pipeline parallelism
     * This enables concurrent API calls to embedding providers AND overlaps
     * embedding generation with database insertion (pipeline parallelism)
     */
    private async processChunkBuffersConcurrently(
        chunkBuffers: Array<Array<{ chunk: CodeChunk; codebasePath: string }>>,
        apiConcurrency: number
    ): Promise<void> {
        if (chunkBuffers.length === 0) return;

        console.log(`[Context] 🚀 Processing ${chunkBuffers.length} embedding batches with pipeline parallelism (concurrency: ${apiConcurrency})`);
        
        // Pipeline: Use a queue to manage embedding generation and DB insertion
        // Stage 1: Generate embeddings (concurrent)
        // Stage 2: Insert to DB (can start before all embeddings are done)
        const dbInsertionQueue: Promise<void>[] = [];
        
        // Process batches in concurrent groups for embedding generation
        for (let i = 0; i < chunkBuffers.length; i += apiConcurrency) {
            const concurrentBatch = chunkBuffers.slice(i, i + apiConcurrency);
            const batchStartTime = Date.now();
            
            // Generate embeddings concurrently
            const embeddingPromises = concurrentBatch.map(async (buffer) => {
                try {
                    return await this.generateEmbeddingsForBuffer(buffer);
                } catch (error) {
                    console.error(`[Context] ❌ Failed to generate embeddings:`, error);
                    throw error;
                }
            });
            
            // Wait for embedding generation and immediately queue DB insertions
            const embeddingResults = await Promise.all(embeddingPromises);
            
            const embeddingTime = Date.now() - batchStartTime;
            console.log(`[Context] ⚡ Generated ${embeddingResults.length} embedding batches in ${embeddingTime}ms`);
            
            // Queue DB insertions (don't wait - pipeline parallelism!)
            for (const { documents, collectionName, isHybrid } of embeddingResults) {
                const insertPromise = this.insertDocumentsToDB(collectionName, documents, isHybrid)
                    .catch(error => {
                        console.error(`[Context] ❌ Failed to insert documents to DB:`, error);
                        throw error;
                    });
                dbInsertionQueue.push(insertPromise);
            }
            
            // Track concurrent DB inserts
            
            // Limit the queue size to prevent memory buildup
            // Wait for some DB insertions to complete if queue is too large
            if (dbInsertionQueue.length >= apiConcurrency * 2) {
                const completedInsertions = await Promise.allSettled(dbInsertionQueue.splice(0, apiConcurrency));
                const failed = completedInsertions.filter(r => r.status === 'rejected');
                if (failed.length > 0) {
                    console.error(`[Context] ❌ ${failed.length} DB insertions failed`);
                }
            }
        }
        
        // Wait for all remaining DB insertions to complete
        console.log(`[Context] 🏁 Waiting for ${dbInsertionQueue.length} remaining DB insertions...`);
        const finalInsertions = await Promise.allSettled(dbInsertionQueue);
        const failed = finalInsertions.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
            console.error(`[Context] ❌ ${failed.length} final DB insertions failed`);
            throw new Error(`Failed to insert ${failed.length} batches to database`);
        }
        console.log(`[Context] ✅ All DB insertions completed successfully`);
    }

    /**
     * Generate embeddings for a buffer of chunks (Stage 1 of pipeline)
     * Returns prepared documents ready for DB insertion
     */
    private async generateEmbeddingsForBuffer(
        chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>
    ): Promise<{ documents: VectorDocument[]; collectionName: string; isHybrid: boolean }> {
        if (chunkBuffer.length === 0) {
            throw new Error('Empty chunk buffer');
        }

        const chunks = chunkBuffer.map(item => item.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;
        const isHybrid = this.getIsHybrid();

        // Generate embedding vectors
        const chunkContents = chunks.map(chunk => chunk.content);
        const embeddingStart = Date.now();
        const embeddings = await this.embedding.embedBatch(chunkContents);
        const embeddingDuration = Date.now() - embeddingStart;

        // Prepare documents (CPU-bound, fast)
        const documents: VectorDocument[] = chunks.map((chunk, index) => {
            if (!chunk.metadata.filePath) {
                throw new Error(`Missing filePath in chunk metadata at index ${index}`);
            }

            const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
            const fileExtension = path.extname(chunk.metadata.filePath);
            const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

            return {
                id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                content: chunk.content,
                vector: embeddings[index].vector,
                relativePath,
                startLine: chunk.metadata.startLine || 0,
                endLine: chunk.metadata.endLine || 0,
                fileExtension,
                metadata: {
                    ...restMetadata,
                    codebasePath,
                    language: chunk.metadata.language || 'unknown',
                    chunkIndex: index
                }
            };
        });

        const collectionName = this.getCollectionName(codebasePath);
        return { documents, collectionName, isHybrid };
    }

    /**
     * Insert documents to vector database (Stage 2 of pipeline)
     * Can run concurrently with embedding generation of other batches
     * Uses batched insertion for better performance
     */
    private async insertDocumentsToDB(
        collectionName: string,
        documents: VectorDocument[],
        isHybrid: boolean
    ): Promise<void> {
        const dbStart = Date.now();
        
        if (isHybrid === true) {
            // Use batched insertion if available (MilvusVectorDatabase)
            const milvusDB = this.vectorDatabase as any;
            if (typeof milvusDB.insertHybridBatched === 'function') {
                await milvusDB.insertHybridBatched(collectionName, documents);
            } else {
                await this.vectorDatabase.insertHybrid(collectionName, documents);
            }
        } else {
            await this.vectorDatabase.insert(collectionName, documents);
        }
        
        const dbDuration = Date.now() - dbStart;
    }

    /**
     * Process a batch of chunks with separated embedding and DB operations
     * This allows for better parallelization
     */
    private async processChunkBatch(chunks: CodeChunk[], codebasePath: string): Promise<void> {
        const isHybrid = this.getIsHybrid();

        // Step 1: Generate embedding vectors (can be done concurrently with other batches)
        const chunkContents = chunks.map(chunk => chunk.content);
        const embeddings = await this.embedding.embedBatch(chunkContents);

        // Step 2: Prepare documents (CPU-bound, fast)
        let documents: VectorDocument[];
        
        if (isHybrid === true) {
            documents = chunks.map((chunk, index) => {
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${index}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

                return {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    content: chunk.content,
                    vector: embeddings[index].vector,
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: index
                    }
                };
            });
        } else {
            documents = chunks.map((chunk, index) => {
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${index}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

                return {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    vector: embeddings[index].vector,
                    content: chunk.content,
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: index
                    }
                };
            });
        }

        // Step 3: Store to vector database (I/O-bound, can overlap with other batches' embeddings)
        const collectionName = this.getCollectionName(codebasePath);
        if (isHybrid === true) {
            await this.vectorDatabase.insertHybrid(collectionName, documents);
        } else {
            await this.vectorDatabase.insert(collectionName, documents);
        }
    }

    /**
     * Calculate optimal batch size based on embedding provider and system capabilities
     */
    private calculateOptimalBatchSize(): number {
        const envBatchSize = parseInt(envManager.get('EMBEDDING_BATCH_SIZE') || '100', 10);
        const provider = this.embedding.getProvider();
        
        // Provider-specific optimal batch sizes based on API limits and performance
        const providerOptimalSizes = {
            'OpenAI': 1500,        // OpenAI supports up to 2048, increased for better throughput
            'VoyageAI': 160,       // VoyageAI increased modestly for better performance
            'Gemini': 140,         // Gemini API limits increased
            'Ollama': 80           // Local models, increased for better efficiency
        };

        const optimalSize = providerOptimalSizes[provider as keyof typeof providerOptimalSizes] || 100;
        const systemMemoryMB = this.getSystemMemory();
        
        // Adjust based on available memory (larger batches for systems with more memory)
        const memoryMultiplier = systemMemoryMB > 8192 ? 1.5 : systemMemoryMB > 4096 ? 1.2 : 1.0;
        const adjustedSize = Math.round(optimalSize * memoryMultiplier);
        
        const finalSize = Math.max(10, Math.min(envBatchSize, adjustedSize));
        console.log(`[Context] 🎯 Calculated batch size: ${finalSize} (provider: ${provider}, system memory: ${systemMemoryMB}MB)`);
        
        return finalSize;
    }

    /**
     * Get current memory usage in MB
     */
    private getMemoryUsage(): number {
        const usage = process.memoryUsage();
        return Math.round(usage.heapUsed / 1024 / 1024);
    }

    /**
     * Get total system memory in MB
     */
    private getSystemMemory(): number {
        try {
            const os = require('os');
            return Math.round(os.totalmem() / 1024 / 1024);
        } catch {
            return 4096; // Default fallback to 4GB
        }
    }

    /**
     * Get programming language based on file extension
     */
    private getLanguageFromExtension(ext: string): string {
        const languageMap: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.py': 'python',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.h': 'c',
            '.hpp': 'cpp',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust',
            '.php': 'php',
            '.rb': 'ruby',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.m': 'objective-c',
            '.mm': 'objective-c',
            '.ipynb': 'jupyter'
        };
        return languageMap[ext] || 'text';
    }

    /**
     * Generate unique ID based on chunk content and location
     * @param relativePath Relative path to the file
     * @param startLine Start line number
     * @param endLine End line number
     * @param content Chunk content
     * @returns Hash-based unique ID
     */
    private generateId(relativePath: string, startLine: number, endLine: number, content: string): string {
        const combinedString = `${relativePath}:${startLine}:${endLine}:${content}`;
        const hash = crypto.createHash('sha256').update(combinedString, 'utf-8').digest('hex');
        return `chunk_${hash.substring(0, 16)}`;
    }

    /**
     * Read ignore patterns from file (e.g., .gitignore)
     * @param filePath Path to the ignore file
     * @returns Array of ignore patterns
     */
    static async getIgnorePatternsFromFile(filePath: string): Promise<string[]> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#')); // Filter out empty lines and comments
        } catch (error) {
            console.warn(`[Context] ⚠️  Could not read ignore file ${filePath}: ${error}`);
            return [];
        }
    }

    /**
     * Load ignore patterns from various ignore files in the codebase
     * This method preserves any existing custom patterns that were added before
     * @param codebasePath Path to the codebase
     */
    private async loadIgnorePatterns(codebasePath: string): Promise<void> {
        try {
            let fileBasedPatterns: string[] = [];

            // Load all .xxxignore files in codebase directory
            const ignoreFiles = await this.findIgnoreFiles(codebasePath);
            for (const ignoreFile of ignoreFiles) {
                const patterns = await this.loadIgnoreFile(ignoreFile, path.basename(ignoreFile));
                fileBasedPatterns.push(...patterns);
            }

            // Load global ~/.context/.contextignore
            const globalIgnorePatterns = await this.loadGlobalIgnoreFile();
            fileBasedPatterns.push(...globalIgnorePatterns);

            // Merge file-based patterns with existing patterns (which may include custom MCP patterns)
            if (fileBasedPatterns.length > 0) {
                this.addCustomIgnorePatterns(fileBasedPatterns);
                console.log(`[Context] 🚫 Loaded total ${fileBasedPatterns.length} ignore patterns from all ignore files`);
            } else {
                console.log('📄 No ignore files found, keeping existing patterns');
            }
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to load ignore patterns: ${error}`);
            // Continue with existing patterns on error - don't reset them
        }
    }

    /**
     * Find all .xxxignore files in the codebase directory
     * @param codebasePath Path to the codebase
     * @returns Array of ignore file paths
     */
    private async findIgnoreFiles(codebasePath: string): Promise<string[]> {
        try {
            const entries = await fs.promises.readdir(codebasePath, { withFileTypes: true });
            const ignoreFiles: string[] = [];

            for (const entry of entries) {
                if (entry.isFile() &&
                    entry.name.startsWith('.') &&
                    entry.name.endsWith('ignore')) {
                    // Skip .npmignore as it's for npm packaging, not code indexing
                    // .npmignore often contains '*' which would ignore everything
                    if (entry.name === '.npmignore') {
                        console.log(`📄 Skipping .npmignore (npm packaging file, not for code indexing)`);
                        continue;
                    }
                    ignoreFiles.push(path.join(codebasePath, entry.name));
                }
            }

            if (ignoreFiles.length > 0) {
                console.log(`📄 Found ignore files: ${ignoreFiles.map(f => path.basename(f)).join(', ')}`);
            }

            return ignoreFiles;
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to scan for ignore files: ${error}`);
            return [];
        }
    }

    /**
     * Load global ignore file from ~/.context/.contextignore
     * @returns Array of ignore patterns
     */
    private async loadGlobalIgnoreFile(): Promise<string[]> {
        try {
            const homeDir = require('os').homedir();
            const globalIgnorePath = path.join(homeDir, '.context', '.contextignore');
            return await this.loadIgnoreFile(globalIgnorePath, 'global .contextignore');
        } catch (error) {
            // Global ignore file is optional, don't log warnings
            return [];
        }
    }

    /**
     * Load ignore patterns from a specific ignore file
     * @param filePath Path to the ignore file
     * @param fileName Display name for logging
     * @returns Array of ignore patterns
     */
    private async loadIgnoreFile(filePath: string, fileName: string): Promise<string[]> {
        try {
            await fs.promises.access(filePath);
            console.log(`📄 Found ${fileName} file at: ${filePath}`);

            const ignorePatterns = await Context.getIgnorePatternsFromFile(filePath);

            if (ignorePatterns.length > 0) {
                console.log(`[Context] 🚫 Loaded ${ignorePatterns.length} ignore patterns from ${fileName}`);
                return ignorePatterns;
            } else {
                console.log(`📄 ${fileName} file found but no valid patterns detected`);
                return [];
            }
        } catch (error) {
            if (fileName.includes('global')) {
                console.log(`📄 No ${fileName} file found`);
            }
            return [];
        }
    }

    /**
     * Check if a path matches any ignore pattern
     * @param filePath Path to check
     * @param basePath Base path for relative pattern matching
     * @returns True if path should be ignored
     */
    private matchesIgnorePattern(filePath: string, basePath: string): boolean {
        if (this.ignorePatterns.length === 0) {
            return false;
        }

        const relativePath = path.relative(basePath, filePath);
        const normalizedPath = relativePath.replace(/\\/g, '/'); // Normalize path separators

        for (const pattern of this.ignorePatterns) {
            if (this.isPatternMatch(normalizedPath, pattern)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Simple glob pattern matching
     * @param filePath File path to test
     * @param pattern Glob pattern
     * @returns True if pattern matches
     */
    private isPatternMatch(filePath: string, pattern: string): boolean {
        // Handle directory patterns (ending with /)
        if (pattern.endsWith('/')) {
            const dirPattern = pattern.slice(0, -1);
            const pathParts = filePath.split('/');
            return pathParts.some(part => this.simpleGlobMatch(part, dirPattern));
        }

        // Handle file patterns
        if (pattern.includes('/')) {
            // Pattern with path separator - match exact path
            return this.simpleGlobMatch(filePath, pattern);
        } else {
            // Pattern without path separator - match filename in any directory
            const fileName = path.basename(filePath);
            return this.simpleGlobMatch(fileName, pattern);
        }
    }

    /**
     * Simple glob matching supporting * wildcard
     * @param text Text to test
     * @param pattern Pattern with * wildcards
     * @returns True if pattern matches
     */
    private simpleGlobMatch(text: string, pattern: string): boolean {
        // Convert glob pattern to regex
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except *
            .replace(/\*/g, '.*'); // Convert * to .*

        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(text);
    }

    /**
     * Get custom extensions from environment variables
     * Supports CUSTOM_EXTENSIONS as comma-separated list
     * @returns Array of custom extensions
     */
    private getCustomExtensionsFromEnv(): string[] {
        const envExtensions = envManager.get('CUSTOM_EXTENSIONS');
        if (!envExtensions) {
            return [];
        }

        try {
            const extensions = envExtensions
                .split(',')
                .map(ext => ext.trim())
                .filter(ext => ext.length > 0)
                .map(ext => ext.startsWith('.') ? ext : `.${ext}`); // Ensure extensions start with dot

            return extensions;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse CUSTOM_EXTENSIONS: ${error}`);
            return [];
        }
    }

    /**
     * Get custom ignore patterns from environment variables  
     * Supports CUSTOM_IGNORE_PATTERNS as comma-separated list
     * @returns Array of custom ignore patterns
     */
    private getCustomIgnorePatternsFromEnv(): string[] {
        const envIgnorePatterns = envManager.get('CUSTOM_IGNORE_PATTERNS');
        if (!envIgnorePatterns) {
            return [];
        }

        try {
            const patterns = envIgnorePatterns
                .split(',')
                .map(pattern => pattern.trim())
                .filter(pattern => pattern.length > 0);

            return patterns;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse CUSTOM_IGNORE_PATTERNS: ${error}`);
            return [];
        }
    }

    /**
     * Add custom extensions (from MCP or other sources) without replacing existing ones
     * @param customExtensions Array of custom extensions to add
     */
    addCustomExtensions(customExtensions: string[]): void {
        if (customExtensions.length === 0) return;

        // Ensure extensions start with dot
        const normalizedExtensions = customExtensions.map(ext =>
            ext.startsWith('.') ? ext : `.${ext}`
        );

        // Merge current extensions with new custom extensions, avoiding duplicates
        const mergedExtensions = [...this.supportedExtensions, ...normalizedExtensions];
        const uniqueExtensions: string[] = [...new Set(mergedExtensions)];
        this.supportedExtensions = uniqueExtensions;
        console.log(`[Context] 📎 Added ${customExtensions.length} custom extensions. Total: ${this.supportedExtensions.length} extensions`);
    }

    /**
     * Get current splitter information
     */
    getSplitterInfo(): { type: string; hasBuiltinFallback: boolean; supportedLanguages?: string[] } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const { AstCodeSplitter } = require('./splitter/ast-splitter');
            return {
                type: 'ast',
                hasBuiltinFallback: true,
                supportedLanguages: AstCodeSplitter.getSupportedLanguages()
            };
        } else {
            return {
                type: 'langchain',
                hasBuiltinFallback: false
            };
        }
    }

    /**
     * Check if current splitter supports a specific language
     * @param language Programming language
     */
    isLanguageSupported(language: string): boolean {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const { AstCodeSplitter } = require('./splitter/ast-splitter');
            return AstCodeSplitter.isLanguageSupported(language);
        }

        // LangChain splitter supports most languages
        return true;
    }

    /**
     * Get which strategy would be used for a specific language
     * @param language Programming language
     */
    getSplitterStrategyForLanguage(language: string): { strategy: 'ast' | 'langchain'; reason: string } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const { AstCodeSplitter } = require('./splitter/ast-splitter');
            const isSupported = AstCodeSplitter.isLanguageSupported(language);

            return {
                strategy: isSupported ? 'ast' : 'langchain',
                reason: isSupported
                    ? 'Language supported by AST parser'
                    : 'Language not supported by AST, will fallback to LangChain'
            };
        } else {
            return {
                strategy: 'langchain',
                reason: 'Using LangChain splitter directly'
            };
        }
    }
}
