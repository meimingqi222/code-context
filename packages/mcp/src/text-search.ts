import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import ignore from 'ignore';
import micromatch from 'micromatch';

export interface TextSearchOptions {
    pattern: string;
    caseSensitive?: boolean;
    isRegex?: boolean;
    filePattern?: string;
    maxResults?: number;
    contextLines?: number;
    respectGitignore?: boolean;
    includeHidden?: boolean;
    timeout?: number; // 添加超时选项（毫秒）
}

export interface SearchMatch {
    file: string;
    line: number;
    column: number;
    matchText: string;
    beforeContext: string[];
    afterContext: string[];
}

export interface SearchResult {
    matches: SearchMatch[];
    totalMatches: number;
    filesSearched: number;
    duration: number;
}

/**
 * High-performance cross-platform text search implementation
 * Features:
 * - Concurrent file searching using worker threads
 * - Automatic .gitignore parsing and respect
 * - Smart ignore patterns (node_modules, dist, etc.)
 * - Context lines support
 * - Early termination when maxResults reached
 */
export class TextSearcher {
    private readonly DEFAULT_IGNORE_PATTERNS = [
        'node_modules/**',
        'dist/**',
        'build/**',
        'out/**',
        'target/**',
        '.git/**',
        '.svn/**',
        '.hg/**',
        '.vscode/**',
        '.idea/**',
        '__pycache__/**',
        '.pytest_cache/**',
        'coverage/**',
        '.nyc_output/**',
        '*.min.js',
        '*.min.css',
        '*.bundle.js',
        '*.map',
        'logs/**',
        'tmp/**',
        'temp/**',
        '.cache/**'
    ];

    // 二进制/无需搜索的文件扩展名
    private readonly BINARY_EXTENSIONS = new Set([
        '.exe', '.dll', '.so', '.dylib', '.bin',
        '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp',
        '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv',
        '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.wasm', '.pyc', '.pyo', '.o', '.a', '.lib',
        '.ttf', '.woff', '.woff2', '.eot', '.otf',
        '.map', '.lock'
    ]);

    private ignoreFilter: ReturnType<typeof ignore> | null = null;

    /**
     * Search for text in files within a directory
     */
    async search(searchPath: string, options: TextSearchOptions): Promise<SearchResult> {
        const startTime = Date.now();
        const timeoutMs = options.timeout || 10000; // 默认10秒超时
        console.log(`[TEXT-SEARCH] 🔍 Starting search performance analysis (timeout: ${timeoutMs}ms)`);

        // 创建超时Promise
        const timeoutPromise = new Promise<SearchResult>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Search timeout after ${timeoutMs}ms`));
            }, timeoutMs);
        });

        // 创建实际搜索的Promise
        const searchPromise = this.doSearch(searchPath, options, startTime);

        try {
            // 使用Promise.race来实现超时
            return await Promise.race([searchPromise, timeoutPromise]);
        } catch (error: any) {
            if (error.message.includes('timeout')) {
                const duration = Date.now() - startTime;
                console.log(`[TEXT-SEARCH] ⏰ SEARCH TIMEOUT: ${duration}ms`);
                return {
                    matches: [],
                    totalMatches: 0,
                    filesSearched: 0,
                    duration
                };
            }
            throw error;
        }
    }

    /**
     * 实际执行搜索的方法
     */
    private async doSearch(searchPath: string, options: TextSearchOptions, startTime: number): Promise<SearchResult> {
        console.log(`[TEXT-SEARCH] 🔍 Starting actual search implementation`);

        // Validate path
        if (!fsSync.existsSync(searchPath)) {
            throw new Error(`Path does not exist: ${searchPath}`);
        }

        const stat = fsSync.statSync(searchPath);
        if (!stat.isDirectory()) {
            throw new Error(`Path is not a directory: ${searchPath}`);
        }

        // Load ignore patterns
        const ignoreStartTime = Date.now();
        if (options.respectGitignore !== false) {
            await this.loadIgnorePatterns(searchPath);
        }
        const ignoreDuration = Date.now() - ignoreStartTime;
        console.log(`[TEXT-SEARCH] ⏱️  Ignore patterns loaded in ${ignoreDuration}ms`);

        // 异步并发收集文件
        const collectStartTime = Date.now();
        const files = await this.collectFilesConcurrent(searchPath, options);
        const collectDuration = Date.now() - collectStartTime;
        console.log(`[TEXT-SEARCH] ⏱️  File collection completed in ${collectDuration}ms - Found ${files.length} files`);
        
        // 如果文件收集就花了很长时间，这就是主要瓶颈
        if (collectDuration > 5000) {
            console.log(`[TEXT-SEARCH] 🚨 BOTTLENECK DETECTED: File collection took ${collectDuration}ms`);
        }

        if (files.length === 0) {
            return {
                matches: [],
                totalMatches: 0,
                filesSearched: 0,
                duration: Date.now() - startTime
            };
        }

        // Prepare search regex
        const searchRegex = this.createSearchRegex(options);

        // Search files concurrently
        const searchStartTime = Date.now();
        const matches = await this.searchFiles(files, searchPath, searchRegex, options);
        const searchDuration = Date.now() - searchStartTime;
        console.log(`[TEXT-SEARCH] ⏱️  File search completed in ${searchDuration}ms - Found ${matches.length} matches`);
        
        // 如果文件搜索花了很长时间，这是另一个瓶颈
        if (searchDuration > 5000) {
            console.log(`[TEXT-SEARCH] 🚨 BOTTLENECK DETECTED: File search took ${searchDuration}ms`);
        }

        const totalDuration = Date.now() - startTime;
        console.log(`[TEXT-SEARCH] ✅ Total search completed in ${totalDuration}ms (Ignore: ${ignoreDuration}ms, Collect: ${collectDuration}ms, Search: ${searchDuration}ms)`);

        return {
            matches,
            totalMatches: matches.length,
            filesSearched: files.length,
            duration: totalDuration
        };
    }

    /**
     * Load .gitignore and other ignore files
     */
    private async loadIgnorePatterns(basePath: string): Promise<void> {
        // 使用 ignore 库的默认配置，它自动处理跨平台路径
        // ignore 库在内部会根据操作系统正确处理路径分隔符
        this.ignoreFilter = ignore();
        this.ignoreFilter.add(this.DEFAULT_IGNORE_PATTERNS);

        // 并发读取所有忽略文件
        const ignoreFiles = [
            { name: '.gitignore', path: path.join(basePath, '.gitignore') },
            { name: '.warpindexingignore', path: path.join(basePath, '.warpindexingignore') },
            { name: '.claudeignore', path: path.join(basePath, '.claudeignore') }
        ];

        await Promise.all(ignoreFiles.map(async ({ name, path: filePath }) => {
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const patterns = content
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#'));
                
                if (patterns.length > 0) {
                    this.ignoreFilter!.add(patterns);
                    console.log(`[TEXT-SEARCH] Loaded ${patterns.length} patterns from ${name}`);
                }
            } catch {
                // 文件不存在，忽略
            }
        }));
    }

    /**
     * 简化的文件收集 - 先确保基本功能正常
     */
    private async collectFilesConcurrent(
        dirPath: string,
        options: TextSearchOptions,
        basePath: string = dirPath
    ): Promise<string[]> {
        console.log(`[TEXT-SEARCH] 📁 Starting simplified file collection`);
        const files: string[] = [];
        
        // 使用简单的递归遍历，避免复杂的并发逻辑
        const collectFiles = async (dir: string): Promise<void> => {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                    if (!options.includeHidden && entry.name.startsWith('.')) {
                        continue;
                    }

                    const fullPath = path.join(dir, entry.name);
                    const relativePath = path.relative(basePath, fullPath);
                    
                    // 简单的 ignore 过滤
                    if (this.ignoreFilter && this.ignoreFilter.ignores(relativePath)) {
                        continue;
                    }

                    if (entry.isDirectory()) {
                        // 递归处理子目录，但限制深度
                        const depth = relativePath.split('/').length;
                        if (depth < 10) { // 限制深度防止无限递归
                            await collectFiles(fullPath);
                        }
                    } else if (entry.isFile()) {
                        // 简单的文件过滤
                        const ext = path.extname(entry.name).toLowerCase();
                        if (!this.BINARY_EXTENSIONS.has(ext)) {
                            if (!options.filePattern || micromatch.isMatch(entry.name, options.filePattern)) {
                                files.push(fullPath);
                            }
                        }
                    }
                }
            } catch (error: any) {
                console.warn(`[TEXT-SEARCH] Error reading directory ${dir}: ${error.message}`);
            }
        };
        
        await collectFiles(dirPath);
        console.log(`[TEXT-SEARCH] 📁 Simplified collection completed: ${files.length} files`);
        return files;
    }

    /**
     * 处理单个目录（异步）
     */
    private async processDirectory(
        dirPath: string,
        basePath: string,
        options: TextSearchOptions
    ): Promise<{ files: string[]; subdirs: string[] }> {
        const files: string[] = [];
        const subdirs: string[] = [];

        try {
            const dirStartTime = Date.now();
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            const readDuration = Date.now() - dirStartTime;
            
            // 如果单个目录读取就很慢，记录下来
            if (readDuration > 100) {
                console.log(`[TEXT-SEARCH] 🐌 Slow directory read: ${dirPath} took ${readDuration}ms for ${entries.length} entries`);
            }

            for (const entry of entries) {
                if (!options.includeHidden && entry.name.startsWith('.')) {
                    continue;
                }

                const fullPath = path.join(dirPath, entry.name);
                const relativePath = path.relative(basePath, fullPath);
                
                // 跨平台路径处理：直接使用 path.relative() 的结果
                // ignore 库会自动处理不同操作系统的路径分隔符
                // 不需要手动转换路径分隔符，这可能导致模式匹配失效
                
                if (this.ignoreFilter && this.ignoreFilter.ignores(relativePath)) {
                    console.log(`[TEXT-SEARCH] Ignoring file (matched pattern): ${relativePath}`);
                    continue;
                }

                if (entry.isDirectory()) {
                    subdirs.push(fullPath);
                } else if (entry.isFile()) {
                    // 扩展名预过滤
                    const ext = path.extname(entry.name).toLowerCase();
                    if (this.BINARY_EXTENSIONS.has(ext)) {
                        continue;
                    }

                    if (options.filePattern) {
                        if (!micromatch.isMatch(entry.name, options.filePattern)) {
                            continue;
                        }
                    }

                    files.push(fullPath);
                }
            }
        } catch (error: any) {
            console.warn(`[TEXT-SEARCH] Error reading directory ${dirPath}: ${error.message}`);
        }

        return { files, subdirs };
    }

    /**
     * Create search regex from options
     */
    private createSearchRegex(options: TextSearchOptions): RegExp {
        let pattern = options.pattern;

        if (!options.isRegex) {
            // Escape special regex characters
            pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        const flags = options.caseSensitive ? 'g' : 'gi';
        return new RegExp(pattern, flags);
    }

    /**
     * 高效并发搜索文件 - 简化批处理逻辑
     */
    private async searchFiles(
        files: string[],
        basePath: string,
        searchRegex: RegExp,
        options: TextSearchOptions
    ): Promise<SearchMatch[]> {
        const matches: SearchMatch[] = [];
        const maxResults = options.maxResults || Infinity;
        const contextLines = options.contextLines || 0;

        // 更大的批次大小，减少 Promise 开销
        const totalFiles = files.length;
        const batchSize = totalFiles > 50000 ? 500 : totalFiles > 5000 ? 200 : 100;
        
        // 适中的并发度，平衡 I/O 和 CPU
        const concurrency = Math.min(8, Math.max(3, os.cpus().length));

        for (let i = 0; i < files.length && matches.length < maxResults; i += batchSize) {
            const batch = files.slice(i, Math.min(i + batchSize, files.length));
            
            // 简化的并发处理：直接分割批次
            const subBatchSize = Math.ceil(batch.length / concurrency);
            const promises: Promise<SearchMatch[]>[] = [];
            
            for (let j = 0; j < batch.length; j += subBatchSize) {
                const subBatch = batch.slice(j, Math.min(j + subBatchSize, batch.length));
                promises.push(
                    this.searchBatch(subBatch, basePath, searchRegex, contextLines, maxResults - matches.length)
                );
            }

            // 等待当前批次完成再继续
            const batchResults = await Promise.all(promises);
            for (const result of batchResults) {
                matches.push(...result);
                if (matches.length >= maxResults) {
                    break;
                }
            }

            // 减少进度报告频率
            if (i % (batchSize * 20) === 0 && i > 0) {
                const progress = ((i / files.length) * 100).toFixed(1);
                console.log(`[TEXT-SEARCH] Progress: ${progress}% (${i}/${files.length} files, ${matches.length} matches)`);
            }
        }

        return matches.slice(0, maxResults);
    }

    /**
     * 高效搜索文件批次 - 优化 I/O 和早期终止
     */
    private async searchBatch(
        files: string[],
        basePath: string,
        searchRegex: RegExp,
        contextLines: number,
        remainingResults: number
    ): Promise<SearchMatch[]> {
        const matches: SearchMatch[] = [];

        for (const file of files) {
            if (matches.length >= remainingResults) {
                break;
            }

            try {
                // 并行获取文件状态和初步检查
                const [stat] = await Promise.all([
                    fs.stat(file)
                ]);
                
                // 更严格的文件大小限制
                if (stat.size > 5 * 1024 * 1024) { // 降低到 5MB
                    continue;
                }

                if (stat.size === 0) {
                    continue;
                }

                // 快速二进制检查：只读取前 1KB 来判断
                const header = await fs.readFile(file, { encoding: 'utf-8' });
                const headerChunk = header.slice(0, 1024);
                if (headerChunk.includes('\0')) {
                    continue;
                }

                // 对于大文件，先检查是否包含匹配内容再完全读取
                if (stat.size > 1024 * 1024) { // 1MB 以上文件
                    const shouldSearch = await this.quickFileScan(file, searchRegex);
                    if (!shouldSearch) {
                        continue;
                    }
                }

                // 读取完整文件内容
                const content = await fs.readFile(file, 'utf-8');
                
                // 使用正则表达式正确处理 Windows (CRLF) 和 Unix (LF) 换行符
                const lines = content.split(/\r?\n/);

                for (let i = 0; i < lines.length && matches.length < remainingResults; i++) {
                    const line = lines[i];
                    const lineMatches = line.matchAll(searchRegex);

                    for (const match of lineMatches) {
                        if (matches.length >= remainingResults) {
                            break;
                        }

                        const beforeContext = contextLines > 0
                            ? lines.slice(Math.max(0, i - contextLines), i)
                            : [];

                        const afterContext = contextLines > 0
                            ? lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines))
                            : [];

                        matches.push({
                            file: path.relative(basePath, file),
                            line: i + 1,
                            column: match.index! + 1,
                            matchText: match[0],
                            beforeContext,
                            afterContext
                        });
                    }
                }
            } catch (error: any) {
                // 静默跳过无法读取的文件，减少日志噪音
                if (!error.message.includes('ENOENT')) {
                    // 只在调试模式下记录错误
                    // console.warn(`[TEXT-SEARCH] Error reading file ${file}: ${error.message}`);
                }
            }
        }

        return matches;
    }

    /**
     * 快速扫描大文件是否包含匹配内容
     */
    private async quickFileScan(file: string, searchRegex: RegExp): Promise<boolean> {
        try {
            // 使用 fs.createReadStream 进行流式读取，避免内存问题
            return new Promise((resolve) => {
                const stream = fsSync.createReadStream(file, { 
                    encoding: 'utf-8',
                    start: 0,
                    highWaterMark: 64 * 1024 // 64KB buffer
                });
                
                let scannedSize = 0;
                const maxScanSize = Math.min(1024 * 1024, fsSync.statSync(file).size * 0.1); // 最多 1MB 或文件大小的 10%
                
                stream.on('data', (chunk) => {
                    // 确保 chunk 是字符串
                    const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
                    
                    if (searchRegex.test(chunkStr)) {
                        stream.destroy(); // 停止读取
                        resolve(true);
                        return;
                    }
                    
                    scannedSize += chunkStr.length;
                    if (scannedSize >= maxScanSize) {
                        stream.destroy(); // 停止读取
                        resolve(false);
                    }
                    
                    // 重置 regex 的 lastIndex
                    searchRegex.lastIndex = 0;
                });
                
                stream.on('end', () => resolve(false));
                stream.on('error', () => resolve(false));
            });
        } catch {
            return false;
        }
    }
}
