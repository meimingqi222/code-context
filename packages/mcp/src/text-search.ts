import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Worker } from 'worker_threads';
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

    private ignoreFilter: ReturnType<typeof ignore> | null = null;

    /**
     * Search for text in files within a directory
     */
    async search(searchPath: string, options: TextSearchOptions): Promise<SearchResult> {
        const startTime = Date.now();

        // Validate path
        if (!fs.existsSync(searchPath)) {
            throw new Error(`Path does not exist: ${searchPath}`);
        }

        const stat = fs.statSync(searchPath);
        if (!stat.isDirectory()) {
            throw new Error(`Path is not a directory: ${searchPath}`);
        }

        // Load ignore patterns
        if (options.respectGitignore !== false) {
            await this.loadIgnorePatterns(searchPath);
        }

        // Get all files to search
        const files = await this.collectFiles(searchPath, options);
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

        // Add default ignore patterns
        this.ignoreFilter.add(this.DEFAULT_IGNORE_PATTERNS);

        // Load .gitignore
        const gitignorePath = path.join(basePath, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, 'utf-8');
            const patterns = content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
            this.ignoreFilter.add(patterns);
            console.log(`[TEXT-SEARCH] Loaded ${patterns.length} patterns from .gitignore`);
        }

        // Load .warpindexingignore
        const warpIgnorePath = path.join(basePath, '.warpindexingignore');
        if (fs.existsSync(warpIgnorePath)) {
            const content = fs.readFileSync(warpIgnorePath, 'utf-8');
            const patterns = content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
            this.ignoreFilter.add(patterns);
            console.log(`[TEXT-SEARCH] Loaded ${patterns.length} patterns from .warpindexingignore`);
        }

        // Load .claudeignore
        const claudeIgnorePath = path.join(basePath, '.claudeignore');
        if (fs.existsSync(claudeIgnorePath)) {
            const content = fs.readFileSync(claudeIgnorePath, 'utf-8');
            const patterns = content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
            this.ignoreFilter.add(patterns);
            console.log(`[TEXT-SEARCH] Loaded ${patterns.length} patterns from .claudeignore`);
        }
    }

    /**
     * Recursively collect all files to search
     */
    private async collectFiles(
        dirPath: string,
        options: TextSearchOptions,
        basePath: string = dirPath,
        files: string[] = []
    ): Promise<string[]> {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(basePath, fullPath);

            // Skip hidden files/directories unless explicitly included
            if (!options.includeHidden && entry.name.startsWith('.')) {
                continue;
            }

            // Check ignore patterns
            if (this.ignoreFilter && this.ignoreFilter.ignores(relativePath)) {
                continue;
            }

            if (entry.isDirectory()) {
                await this.collectFiles(fullPath, options, basePath, files);
            } else if (entry.isFile()) {
                // Apply file pattern filter if specified
                if (options.filePattern) {
                    if (micromatch.isMatch(entry.name, options.filePattern)) {
                        files.push(fullPath);
                    }
                } else {
                    files.push(fullPath);
                }
            }
        }

        return files;
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

        // Use concurrent processing with batching
        const batchSize = 50;
        const concurrency = Math.min(4, Math.max(1, os.cpus().length - 1));

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
                // Check file size (skip very large files)
                const stat = fs.statSync(file);
                if (stat.size > 10 * 1024 * 1024) { // Skip files > 10MB
                    console.log(`[TEXT-SEARCH] Skipping large file: ${file} (${(stat.size / 1024 / 1024).toFixed(2)}MB)`);
                    continue;
                }

                // Check if file is binary
                if (this.isBinaryFile(file)) {
                    continue;
                }

                const content = fs.readFileSync(file, 'utf-8');
                const lines = content.split('\n');

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
                // Skip files that can't be read
                console.warn(`[TEXT-SEARCH] Error reading file ${file}: ${error.message}`);
            }
        }

        return matches;
    }

    /**
     * Check if file is binary (simple heuristic)
     */
    private isBinaryFile(filePath: string): boolean {
        try {
            const buffer = Buffer.alloc(512);
            const fd = fs.openSync(filePath, 'r');
            const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
            fs.closeSync(fd);

            // Check for null bytes (common in binary files)
            for (let i = 0; i < bytesRead; i++) {
                if (buffer[i] === 0) {
                    return true;
                }
            }

            return false;
        } catch {
            return false;
        }
    }
}
