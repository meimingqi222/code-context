import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CodeContext } from '@zilliz/code-context-core';

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
 * 统一的索引管理器 - VSCode 插件作为主要的索引管理者
 * 负责所有代码索引操作，并通过共享状态文件与 MCP 通信
 */
export class IndexManager {
    private context: vscode.ExtensionContext;
    private codeContext: CodeContext;
    private activeIndexing = new Map<string, IndexingProgress>();
    private indexMetadata = new Map<string, IndexMetadata>();
    private stateFilePath: string;
    private statusBarItem: vscode.StatusBarItem;
    private outputChannel: vscode.OutputChannel;

    constructor(context: vscode.ExtensionContext, codeContext: CodeContext) {
        this.context = context;
        this.codeContext = codeContext;
        
        // 创建共享状态文件路径（在用户数据目录）
        const userDataPath = path.join(context.globalStorageUri.fsPath, '..');
        this.stateFilePath = path.join(userDataPath, 'code-context-shared-state.json');
        
        // 创建状态栏项目
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right, 
            100
        );
        this.statusBarItem.command = 'semanticCodeSearch.showIndexingProgress';
        context.subscriptions.push(this.statusBarItem);

        // 创建输出通道
        this.outputChannel = vscode.window.createOutputChannel('Code Context Indexing');
        context.subscriptions.push(this.outputChannel);

        // 初始化
        this.loadPersistedState();
        this.updateSharedState();
        this.updateStatusBar();

        // 注册命令
        context.subscriptions.push(
            vscode.commands.registerCommand('semanticCodeSearch.showIndexingProgress', () => {
                this.showIndexingProgress();
            })
        );
    }

    /**
     * 开始索引代码库
     */
    async indexCodebase(
        codebasePath: string, 
        force: boolean = false,
        splitterType: string = 'ast'
    ): Promise<void> {
        const absolutePath = path.resolve(codebasePath);
        
        // 检查是否已在索引中
        if (this.activeIndexing.has(absolutePath)) {
            throw new Error(`Codebase '${absolutePath}' is already being indexed`);
        }

        // 检查是否已索引（除非强制重新索引）
        if (!force && this.indexMetadata.has(absolutePath)) {
            const metadata = this.indexMetadata.get(absolutePath)!;
            if (metadata.status === 'indexed') {
                throw new Error(`Codebase '${absolutePath}' is already indexed. Use force=true to re-index.`);
            }
        }

        // 创建进度对象
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

        this.activeIndexing.set(absolutePath, progress);
        this.updateSharedState();
        this.updateStatusBar();

        try {
            // 显示进度通知
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Indexing ${path.basename(absolutePath)}`,
                cancellable: true
            }, async (progressReporter, token) => {
                
                // 设置取消处理
                token.onCancellationRequested(() => {
                    progress.status = 'cancelled';
                    this.updateProgress(absolutePath, progress);
                });

                // 开始索引
                progress.status = 'indexing';
                this.updateProgress(absolutePath, progress);

                const stats = await this.codeContext.indexCodebase(
                    absolutePath,
                    (progressInfo) => {
                        if (token.isCancellationRequested) {
                            throw new Error('Indexing cancelled by user');
                        }

                        // 更新进度
                        progress.phase = progressInfo.phase;
                        progress.current = progressInfo.current;
                        progress.total = progressInfo.total;
                        progress.percentage = progressInfo.percentage;
                        progress.lastUpdated = Date.now();

                        this.updateProgress(absolutePath, progress);

                        // 更新 VSCode 进度显示
                        progressReporter.report({
                            increment: 0, // 使用绝对百分比而不是增量
                            message: `${progressInfo.phase} (${progressInfo.percentage}%)`
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

                // 创建索引元数据
                const metadata: IndexMetadata = {
                    path: absolutePath,
                    collectionName: this.getCollectionName(absolutePath),
                    lastIndexed: Date.now(),
                    status: 'indexed',
                    stats: progress.stats
                };

                this.indexMetadata.set(absolutePath, metadata);
                this.updateProgress(absolutePath, progress);

                // 延迟移除活动索引状态
                setTimeout(() => {
                    this.activeIndexing.delete(absolutePath);
                    this.updateSharedState();
                    this.updateStatusBar();
                }, 2000);

                this.outputChannel.appendLine(
                    `✅ Indexing completed: ${absolutePath} (${stats.indexedFiles} files, ${stats.totalChunks} chunks)`
                );

                vscode.window.showInformationMessage(
                    `✅ Indexing completed! ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`
                );
            });

        } catch (error: any) {
            progress.status = 'error';
            progress.error = error.message;
            progress.phase = 'Error';
            this.updateProgress(absolutePath, progress);

            this.outputChannel.appendLine(`❌ Indexing failed: ${absolutePath} - ${error.message}`);
            
            // 延迟移除错误状态
            setTimeout(() => {
                this.activeIndexing.delete(absolutePath);
                this.updateSharedState();
                this.updateStatusBar();
            }, 5000);

            throw error;
        }
    }

    /**
     * 清除索引
     */
    async clearIndex(codebasePath: string): Promise<void> {
        const absolutePath = path.resolve(codebasePath);

        // 取消正在进行的索引
        if (this.activeIndexing.has(absolutePath)) {
            const progress = this.activeIndexing.get(absolutePath)!;
            progress.status = 'cancelled';
            this.updateProgress(absolutePath, progress);
            this.activeIndexing.delete(absolutePath);
        }

        // 清除向量数据库中的索引
        await this.codeContext.clearIndex(absolutePath);

        // 移除元数据
        this.indexMetadata.delete(absolutePath);

        this.updateSharedState();
        this.updateStatusBar();

        this.outputChannel.appendLine(`🗑️ Index cleared: ${absolutePath}`);
        vscode.window.showInformationMessage(`✅ Index cleared: ${path.basename(absolutePath)}`);
    }

    /**
     * 获取索引状态
     */
    getIndexingStatus(codebasePath?: string): IndexingProgress[] {
        if (codebasePath) {
            const absolutePath = path.resolve(codebasePath);
            const progress = this.activeIndexing.get(absolutePath);
            return progress ? [progress] : [];
        }
        return Array.from(this.activeIndexing.values());
    }

    /**
     * 获取已索引的代码库
     */
    getIndexedCodebases(): IndexMetadata[] {
        return Array.from(this.indexMetadata.values()).filter(
            metadata => metadata.status === 'indexed'
        );
    }

    /**
     * 更新进度
     */
    private updateProgress(path: string, progress: IndexingProgress): void {
        progress.lastUpdated = Date.now();
        this.activeIndexing.set(path, progress);
        this.updateSharedState();
        this.updateStatusBar();

        // 输出详细进度到输出通道
        this.outputChannel.appendLine(
            `[${new Date().toLocaleTimeString()}] ${path}: ${progress.phase} (${progress.percentage}%)`
        );
    }

    /**
     * 更新共享状态文件
     */
    private updateSharedState(): void {
        const state: SharedIndexState = {
            version: 1,
            lastUpdated: Date.now(),
            indexes: Array.from(this.indexMetadata.values()),
            activeIndexing: Array.from(this.activeIndexing.values())
        };

        try {
            // 确保删除目录存在
            const dir = path.dirname(this.stateFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2));
        } catch (error) {
            console.error('Failed to update shared state:', error);
        }

        // 同时保存到 VSCode 状态
        this.context.globalState.update('codeContextIndexes', Array.from(this.indexMetadata.entries()));
    }

    /**
     * 加载持续化状态
     */
    private loadPersistedState(): void {
        // 从 VSCode globalState 加载
        const savedIndexes = this.context.globalState.get<[string, IndexMetadata][]>('codeContextIndexes', []);
        this.indexMetadata = new Map(savedIndexes);

        // 验证索引是否仍然有效
        for (const [path, metadata] of this.indexMetadata.entries()) {
            if (!fs.existsSync(path)) {
                this.indexMetadata.delete(path);
            }
        }
    }

    /**
     * 更新状态栏
     */
    private updateStatusBar(): void {
        const activeCount = this.activeIndexing.size;
        const indexedCount = this.indexMetadata.size;

        if (activeCount > 0) {
            const totalProgress = Array.from(this.activeIndexing.values())
                .reduce((sum, p) => sum + p.percentage, 0) / activeCount;
            
            this.statusBarItem.text = `$(sync~spin) Indexing... ${Math.round(totalProgress)}%`;
            this.statusBarItem.tooltip = `${activeCount} codebase(s) being indexed\n${indexedCount} codebase(s) indexed`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (indexedCount > 0) {
            this.statusBarItem.text = `$(database) ${indexedCount} indexed`;
            this.statusBarItem.tooltip = `${indexedCount} codebase(s) are indexed and ready for search`;
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = `$(search) Code Context`;
            this.statusBarItem.tooltip = 'No codebases indexed. Click to start indexing.';
            this.statusBarItem.backgroundColor = undefined;
        }

        this.statusBarItem.show();
    }

    /**
     * 显示索引进度面板
     */
    private async showIndexingProgress(): Promise<void> {
        const activeIndexing = Array.from(this.activeIndexing.values());
        const indexedCodebases = this.getIndexedCodebases();

        if (activeIndexing.length === 0 && indexedCodebases.length === 0) {
            const action = await vscode.window.showInformationMessage(
                'No codebases are currently indexed. Would you like to index your workspace?',
                'Index Workspace'
            );
            if (action === 'Index Workspace') {
                vscode.commands.executeCommand('semanticCodeSearch.indexCodebase');
            }
            return;
        }

        const items: vscode.QuickPickItem[] = [];

        // 添加正在索引的项目
        for (const progress of activeIndexing) {
            const name = path.basename(progress.path);
            items.push({
                label: `$(sync~spin) ${name}`,
                description: `${progress.phase} - ${progress.percentage}%`,
                detail: progress.path
            });
        }

        // 添加已索引的项目
        for (const metadata of indexedCodebases) {
            const name = path.basename(metadata.path);
            const stats = metadata.stats ? ` (${metadata.stats.indexedFiles} files, ${metadata.stats.totalChunks} chunks)` : '';
            items.push({
                label: `$(database) ${name}`,
                description: `Indexed ${new Date(metadata.lastIndexed).toLocaleString()}${stats}`,
                detail: metadata.path
            });
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Code Context - Indexing Status',
            ignoreFocusOut: true
        });

        if (selected) {
            // 可以在这里添加更多操作，比如查看详情、清除索引等
            const actions = await vscode.window.showQuickPick([
                '$(search) Search in this codebase',
                '$(trash) Clear this index',
                '$(refresh) Re-index this codebase'
            ], {
                placeHolder: `Actions for ${path.basename(selected.detail!)}`
            });

            if (actions?.includes('Clear')) {
                await this.clearIndex(selected.detail!);
            } else if (actions?.includes('Re-index')) {
                await this.indexCodebase(selected.detail!, true);
            } else if (actions?.includes('Search')) {
                vscode.commands.executeCommand('semanticCodeSearch.semanticSearch');
            }
        }
    }

    /**
     * 生成集合名称
     */
    private getCollectionName(codebasePath: string): string {
        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        return `code_chunks_${hash.substring(0, 8)}`;
    }

    /**
     * 清理资源
     */
    dispose(): void {
        this.statusBarItem.dispose();
        this.outputChannel.dispose();
    }
}
