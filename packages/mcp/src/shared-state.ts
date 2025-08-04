import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface IndexingProgress {
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

export interface IndexMetadata {
    path: string;
    collectionName: string;
    lastIndexed: number;
    status: 'indexed' | 'indexing' | 'error';
    stats?: {
        indexedFiles: number;
        totalChunks: number;
    };
}

export interface SharedIndexState {
    version: number;
    lastUpdated: number;
    indexes: IndexMetadata[];
    activeIndexing: IndexingProgress[];
}

/**
 * MCP 服务器的共享状态管理器
 * 从 VSCode 插件创建的共享状态文件读取索引信息
 */
export class SharedStateManager {
    private stateFilePath: string;
    private lastStateTime: number = 0;
    private cachedState: SharedIndexState | null = null;
    private fsWatcher: fs.FSWatcher | null = null;
    private stateChangeCallbacks: Array<(state: SharedIndexState) => void> = [];

    constructor() {
        // 查找共享状态文件
        this.stateFilePath = this.findSharedStateFile();
        console.log(`[SHARED-STATE] Using state file: ${this.stateFilePath}`);
        
        // 初始加载状态
        this.loadState();
        this.setupFileWatcher();
    }

    /**
     * 查找共享状态文件
     */
    private findSharedStateFile(): string {
        // 常见的 VSCode 用户数据目录位置
        const possiblePaths = [
            // Windows
            path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'code-context-shared-state.json'),
            path.join(os.homedir(), 'AppData', 'Roaming', 'Code - Insiders', 'User', 'code-context-shared-state.json'),
            
            // macOS
            path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'code-context-shared-state.json'),
            path.join(os.homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'code-context-shared-state.json'),
            
            // Linux
            path.join(os.homedir(), '.config', 'Code', 'User', 'code-context-shared-state.json'),
            path.join(os.homedir(), '.config', 'Code - Insiders', 'User', 'code-context-shared-state.json'),
            
            // 备用位置：当前工作目录
            path.join(process.cwd(), '.code-context-shared-state.json')
        ];

        // 查找第一个存在的文件
        for (const filePath of possiblePaths) {
            if (fs.existsSync(filePath)) {
                return filePath;
            }
        }

        // 如果都不存在，返回最可能的位置（根据平台）
        const platform = os.platform();
        if (platform === 'win32') {
            return possiblePaths[0];
        } else if (platform === 'darwin') {
            return possiblePaths[2];
        } else {
            return possiblePaths[4];
        }
    }

    /**
     * 设置文件监听器
     */
    private setupFileWatcher(): void {
        try {
            // 确保目录存在
            const dir = path.dirname(this.stateFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // 监听文件变化
            this.fsWatcher = fs.watch(this.stateFilePath, (eventType) => {
                if (eventType === 'change') {
                    console.log('[SHARED-STATE] State file changed, reloading...');
                    this.loadState();
                }
            });

            console.log('[SHARED-STATE] File watcher set up successfully');
        } catch (error) {
            console.warn('[SHARED-STATE] Failed to set up file watcher:', error);
        }
    }

    /**
     * 监听状态变化
     */
    onStateChange(callback: (state: SharedIndexState) => void): void {
        this.stateChangeCallbacks.push(callback);
    }

    /**
     * 加载共享状态
     */
    private loadState(): void {
        try {
            if (!fs.existsSync(this.stateFilePath)) {
                console.log('[SHARED-STATE] State file does not exist, using empty state');
                this.cachedState = {
                    version: 1,
                    lastUpdated: 0,
                    indexes: [],
                    activeIndexing: []
                };
                return;
            }

            const stats = fs.statSync(this.stateFilePath);
            if (stats.mtime.getTime() <= this.lastStateTime) {
                // 文件没有更新，使用缓存
                return;
            }

            const content = fs.readFileSync(this.stateFilePath, 'utf-8');
            const state = JSON.parse(content) as SharedIndexState;
            
            this.cachedState = state;
            this.lastStateTime = stats.mtime.getTime();

            console.log(`[SHARED-STATE] Loaded state: ${state.indexes.length} indexed, ${state.activeIndexing.length} indexing`);

            // 通知监听器状态变化
            this.stateChangeCallbacks.forEach(callback => {
                try {
                    callback(state);
                } catch (error) {
                    console.error('[SHARED-STATE] Error in state change callback:', error);
                }
            });

        } catch (error) {
            console.error('[SHARED-STATE] Failed to load state file:', error);
            // 使用默认状态
            this.cachedState = {
                version: 1,
                lastUpdated: 0,
                indexes: [],
                activeIndexing: []
            };
        }
    }

    /**
     * 获取当前状态
     */
    getState(): SharedIndexState {
        // 每次获取时都尝试重新加载（以防文件监听器失效）
        this.loadState();
        return this.cachedState || {
            version: 1,
            lastUpdated: 0,
            indexes: [],
            activeIndexing: []
        };
    }

    /**
     * 保存状态到共享文件
     */
    private saveState(state: SharedIndexState): void {
        try {
            // 确保目录存在
            const dir = path.dirname(this.stateFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // 更新时间戳
            state.lastUpdated = Date.now();
            
            // 写入文件
            fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
            
            // 更新缓存
            this.cachedState = state;
            this.lastStateTime = Date.now();
            
            console.log(`[SHARED-STATE] State saved: ${state.indexes.length} indexed, ${state.activeIndexing.length} indexing`);
            
            // 通知监听器状态变化
            this.stateChangeCallbacks.forEach(callback => {
                try {
                    callback(state);
                } catch (error) {
                    console.error('[SHARED-STATE] Error in state change callback:', error);
                }
            });
            
        } catch (error) {
            console.error('[SHARED-STATE] Failed to save state file:', error);
        }
    }

    /**
     * 添加索引进度到共享状态
     */
    addIndexingProgress(progress: IndexingProgress): void {
        const currentState = this.getState();
        
        // 检查是否已存在相同路径的索引进度
        const existingIndex = currentState.activeIndexing.findIndex(p => 
            path.resolve(p.path) === path.resolve(progress.path)
        );
        
        if (existingIndex >= 0) {
            // 更新现有进度
            currentState.activeIndexing[existingIndex] = progress;
        } else {
            // 添加新进度
            currentState.activeIndexing.push(progress);
        }
        
        this.saveState(currentState);
        console.log(`[SHARED-STATE] Added/Updated indexing progress for: ${progress.path}`);
    }

    /**
     * 更新索引进度
     */
    updateIndexingProgress(codebasePath: string, updates: Partial<IndexingProgress>): void {
        const currentState = this.getState();
        const absolutePath = codebasePath;
        
        const progressIndex = currentState.activeIndexing.findIndex(p => 
            path.resolve(p.path) === path.resolve(absolutePath)
        );
        
        if (progressIndex >= 0) {
            // 更新现有进度
            Object.assign(currentState.activeIndexing[progressIndex], updates);
            currentState.activeIndexing[progressIndex].lastUpdated = Date.now();
            this.saveState(currentState);
        }
    }

    /**
     * 移除索引进度并添加到已完成索引
     */
    completeIndexing(progress: IndexingProgress, collectionName: string): void {
        const currentState = this.getState();
        const absolutePath = progress.path;
        
        // 从活动索引中移除
        currentState.activeIndexing = currentState.activeIndexing.filter(p => 
            path.resolve(p.path) !== path.resolve(absolutePath)
        );
        
        // 检查是否已存在相同路径的索引
        const existingIndex = currentState.indexes.findIndex(idx => 
            path.resolve(idx.path) === path.resolve(absolutePath)
        );
        
        const indexMetadata: IndexMetadata = {
            path: absolutePath,
            collectionName,
            lastIndexed: Date.now(),
            status: 'indexed',
            stats: progress.stats
        };
        
        if (existingIndex >= 0) {
            // 更新现有索引信息
            currentState.indexes[existingIndex] = indexMetadata;
        } else {
            // 添加新索引信息
            currentState.indexes.push(indexMetadata);
        }
        
        this.saveState(currentState);
        console.log(`[SHARED-STATE] Completed indexing for: ${absolutePath}`);
    }

    /**
     * 移除索引进度（索引失败时）
     */
    removeIndexingProgress(codebasePath: string): void {
        const currentState = this.getState();
        const absolutePath = codebasePath;
        
        // 从活动索引中移除
        const initialLength = currentState.activeIndexing.length;
        currentState.activeIndexing = currentState.activeIndexing.filter(p => 
            path.resolve(p.path) !== path.resolve(absolutePath)
        );
        
        if (currentState.activeIndexing.length < initialLength) {
            this.saveState(currentState);
            console.log(`[SHARED-STATE] Removed failed indexing progress for: ${absolutePath}`);
        }
    }

    /**
     * 清除指定路径的索引
     */
    clearIndex(codebasePath: string): void {
        const currentState = this.getState();
        const absolutePath = codebasePath;
        
        // 从已完成索引中移除
        const initialIndexLength = currentState.indexes.length;
        currentState.indexes = currentState.indexes.filter(idx => 
            path.resolve(idx.path) !== path.resolve(absolutePath)
        );
        
        // 从活动索引中移除
        const initialActiveLength = currentState.activeIndexing.length;
        currentState.activeIndexing = currentState.activeIndexing.filter(p => 
            path.resolve(p.path) !== path.resolve(absolutePath)
        );
        
        if (currentState.indexes.length < initialIndexLength || 
            currentState.activeIndexing.length < initialActiveLength) {
            this.saveState(currentState);
            console.log(`[SHARED-STATE] Cleared index for: ${absolutePath}`);
        }
    }

    /**
     * 获取已索引的代码库
     */
    getIndexedCodebases(): IndexMetadata[] {
        const state = this.getState();
        return state.indexes.filter(index => index.status === 'indexed');
    }

    /**
     * 获取正在索引的代码库
     */
    getIndexingCodebases(): IndexingProgress[] {
        const state = this.getState();
        return state.activeIndexing.filter(progress => 
            progress.status === 'preparing' || progress.status === 'indexing'
        );
    }

    /**
     * 检查代码库是否已索引
     */
    isCodebaseIndexed(codebasePath: string): boolean {
        const absolutePath = path.resolve(codebasePath);
        const indexed = this.getIndexedCodebases();
        return indexed.some(index => path.resolve(index.path) === absolutePath);
    }

    /**
     * 检查代码库是否正在索引
     */
    isCodebaseIndexing(codebasePath: string): boolean {
        const absolutePath = path.resolve(codebasePath);
        const indexing = this.getIndexingCodebases();
        return indexing.some(progress => path.resolve(progress.path) === absolutePath);
    }

    /**
     * 获取特定代码库的索引进度
     */
    getIndexingProgress(codebasePath: string): IndexingProgress | null {
        const absolutePath = path.resolve(codebasePath);
        const state = this.getState();
        return state.activeIndexing.find(progress => 
            path.resolve(progress.path) === absolutePath
        ) || null;
    }

    /**
     * 智能检查索引状态：检查当前路径或其父目录是否已被索引
     */
    checkIndexingStatus(targetPath: string): { 
        isIndexed: boolean; 
        isIndexing: boolean; 
        indexedPath?: string; 
        indexingPath?: string;
    } {
        const indexed = this.getIndexedCodebases();
        const indexing = this.getIndexingCodebases();
        
        // 首先检查精确匹配
        const normalizedTarget = path.resolve(targetPath);
        
        for (const index of indexed) {
            const normalizedIndexed = path.resolve(index.path);
            if (normalizedTarget === normalizedIndexed) {
                console.log(`[SHARED-STATE] ✅ Exact match found - '${targetPath}' is indexed`);
                return { isIndexed: true, isIndexing: false, indexedPath: index.path };
            }
        }
        
        for (const progress of indexing) {
            const normalizedIndexing = path.resolve(progress.path);
            if (normalizedTarget === normalizedIndexing) {
                console.log(`[SHARED-STATE] 🔄 Exact match found - '${targetPath}' is being indexed`);
                return { isIndexed: false, isIndexing: true, indexingPath: progress.path };
            }
        }
        
        // 检查父目录是否已被索引（父目录包含子目录）
        for (const index of indexed) {
            const normalizedIndexed = path.resolve(index.path);
            // 检查目标路径是否在已索引的路径下
            if (normalizedTarget.startsWith(normalizedIndexed + path.sep) || normalizedTarget === normalizedIndexed) {
                console.log(`[SHARED-STATE] 📁 Parent directory '${index.path}' contains target '${targetPath}'`);
                return { isIndexed: true, isIndexing: false, indexedPath: index.path };
            }
        }
        
        for (const progress of indexing) {
            const normalizedIndexing = path.resolve(progress.path);
            // 检查目标路径是否在正在索引的路径下
            if (normalizedTarget.startsWith(normalizedIndexing + path.sep) || normalizedTarget === normalizedIndexing) {
                console.log(`[SHARED-STATE] 📁 Parent directory '${progress.path}' (being indexed) contains target '${targetPath}'`);
                return { isIndexed: false, isIndexing: true, indexingPath: progress.path };
            }
        }
        
        console.log(`[SHARED-STATE] ❌ No indexed parent found for '${targetPath}'`);
        return { isIndexed: false, isIndexing: false };
    }

    /**
     * 等待代码库索引完成
     */
    async waitForIndexing(codebasePath: string, timeoutMs: number = 300000): Promise<boolean> {
        const absolutePath = path.resolve(codebasePath);
        const startTime = Date.now();

        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                
                if (elapsed > timeoutMs) {
                    console.log(`[SHARED-STATE] Timeout waiting for indexing: ${absolutePath}`);
                    clearInterval(checkInterval);
                    resolve(false);
                    return;
                }

                const { isIndexed, isIndexing } = this.checkIndexingStatus(absolutePath);
                
                if (isIndexed) {
                    console.log(`[SHARED-STATE] Indexing completed: ${absolutePath}`);
                    clearInterval(checkInterval);
                    resolve(true);
                } else if (!isIndexing) {
                    console.log(`[SHARED-STATE] Indexing stopped/failed: ${absolutePath}`);
                    clearInterval(checkInterval);
                    resolve(false);
                }
                
                // 继续等待
            }, 1000);
        });
    }

    /**
     * 获取格式化的状态报告
     */
    getStatusReport(): string {
        const state = this.getState();
        const indexed = state.indexes.filter(i => i.status === 'indexed');
        const indexing = state.activeIndexing.filter(p => p.status === 'indexing' || p.status === 'preparing');

        let report = `Code Context Index Status:\n`;
        report += `Last updated: ${new Date(state.lastUpdated).toLocaleString()}\n\n`;

        if (indexed.length > 0) {
            report += `Indexed codebases (${indexed.length}):\n`;
            for (const index of indexed) {
                const stats = index.stats ? ` (${index.stats.indexedFiles} files, ${index.stats.totalChunks} chunks)` : '';
                report += `• ${index.path}${stats}\n`;
            }
            report += '\n';
        }

        if (indexing.length > 0) {
            report += `Currently indexing (${indexing.length}):\n`;
            for (const progress of indexing) {
                const elapsed = Math.round((Date.now() - progress.startTime) / 1000);
                report += `• ${progress.path} - ${progress.phase} (${progress.percentage}%, ${elapsed}s elapsed)\n`;
            }
            report += '\n';
        }

        if (indexed.length === 0 && indexing.length === 0) {
            report += 'No codebases are currently indexed or being indexed.\n';
            report += 'VSCode 插件需要先索引代码库才能进行搜索。\n';
        }

        return report;
    }

    /**
     * 清理资源
     */
    dispose(): void {
        if (this.fsWatcher) {
            this.fsWatcher.close();
            this.fsWatcher = null;
        }
        this.stateChangeCallbacks = [];
    }
}
