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

        // Validate path
        if (!fsSync.existsSync(searchPath)) {
            throw new Error(`Path does not exist: ${searchPath}`);
        }

        const stat = fsSync.statSync(searchPath);
        if (!stat.isDirectory()) {
            throw new Error(`Path is not a directory: ${searchPath}`);
        }

        // Load ignore patterns
        if (options.respectGitignore !== false) {
            await this.loadIgnorePatterns(searchPath);
        }

        // 异步并发收集文件
        const files = await this.collectFilesConcurrent(searchPath, options);
        console.log(`[TEXT-SEARCH] Found ${files.length} files to search`);

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
        const matches = await this.searchFiles(files, searchPath, searchRegex, options);

        const duration = Date.now() - startTime;

        return {
            matches,
            totalMatches: matches.length,
            filesSearched: files.length,
            duration
        };
    }

    /**
     * Load .gitignore and other ignore files
     */
    private async loadIgnorePatterns(basePath: string): Promise<void> {
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
     * 异步并发收集文件
     */
    private async collectFilesConcurrent(
        dirPath: string,
        options: TextSearchOptions,
        basePath: string = dirPath
    ): Promise<string[]> {
        const files: string[] = [];
        const dirsToProcess: string[] = [dirPath];
        const concurrency = Math.max(8, os.cpus().length);

        while (dirsToProcess.length > 0) {
            const batch = dirsToProcess.splice(0, concurrency);
            const batchResults = await Promise.all(
                batch.map(dir => this.processDirectory(dir, basePath, options))
            );

            for (const { files: dirFiles, subdirs } of batchResults) {
                files.push(...dirFiles);
                dirsToProcess.push(...subdirs);
            }
        }

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
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                if (!options.includeHidden && entry.name.startsWith('.')) {
                    continue;
                }

                const fullPath = path.join(dirPath, entry.name);
                const relativePath = path.relative(basePath, fullPath);
                const normalizedPath = relativePath.replace(/\\/g, '/');

                if (this.ignoreFilter && this.ignoreFilter.ignores(normalizedPath)) {
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
     * Search files concurrently using multiple strategies
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

        // 自适应批次大小和并发度
        const totalFiles = files.length;
        const batchSize = totalFiles > 10000 ? 200 : totalFiles > 1000 ? 100 : 50;
        const concurrency = Math.max(8, os.cpus().length * 2);

        for (let i = 0; i < files.length && matches.length < maxResults; i += batchSize) {
            const batch = files.slice(i, Math.min(i + batchSize, files.length));

            // Process batch concurrently
            const batchPromises = [];
            for (let j = 0; j < batch.length && matches.length < maxResults; j += Math.ceil(batch.length / concurrency)) {
                const subBatch = batch.slice(j, Math.min(j + Math.ceil(batch.length / concurrency), batch.length));
                batchPromises.push(
                    this.searchBatch(subBatch, basePath, searchRegex, contextLines, maxResults - matches.length)
                );
            }

            const batchResults = await Promise.all(batchPromises);
            for (const result of batchResults) {
                matches.push(...result);
                if (matches.length >= maxResults) {
                    break;
                }
            }

            // 进度报告
            if (i % (batchSize * 10) === 0 && i > 0) {
                const progress = ((i / files.length) * 100).toFixed(1);
                console.log(`[TEXT-SEARCH] Progress: ${progress}% (${i}/${files.length} files, ${matches.length} matches)`);
            }
        }

        return matches.slice(0, maxResults);
    }

    /**
     * Search a batch of files
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
                // 获取文件大小
                const stat = await fs.stat(file);
                if (stat.size > 10 * 1024 * 1024) {
                    console.log(`[TEXT-SEARCH] Skipping large file: ${file} (${(stat.size / 1024 / 1024).toFixed(2)}MB)`);
                    continue;
                }

                if (stat.size === 0) {
                    continue;
                }

                // 读取文件内容并检查二进制
                const content = await fs.readFile(file, 'utf-8');
                if (content.includes('\0')) {
                    continue;
                }
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
                // 跳过无法读取的文件
                if (!error.message.includes('ENOENT')) {
                    console.warn(`[TEXT-SEARCH] Error reading file ${file}: ${error.message}`);
                }
            }
        }

        return matches;
    }
}
