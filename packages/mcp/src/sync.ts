import * as fs from "fs";
import { Context, FileSynchronizer } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";

export class SyncManager {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private isSyncing: boolean = false;
    private syncIntervalId: NodeJS.Timeout | null = null;

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
    }

    public async handleSyncIndex(): Promise<void> {
        const syncStartTime = Date.now();
        if (process.env.NODE_ENV === 'development') {
            console.log(`[SYNC-DEBUG] handleSyncIndex() called at ${new Date().toISOString()}`);
        }

        const indexedCodebases = this.snapshotManager.getIndexedCodebases();

        if (indexedCodebases.length === 0) {
            if (process.env.NODE_ENV === 'development') {
                console.log('[SYNC-DEBUG] No codebases indexed. Skipping sync.');
            }
            return;
        }

        if (process.env.NODE_ENV === 'development') {
            console.log(`[SYNC-DEBUG] Found ${indexedCodebases.length} indexed codebases:`, indexedCodebases);
        }

        if (this.isSyncing) {
            if (process.env.NODE_ENV === 'development') {
                console.log('[SYNC-DEBUG] Index sync already in progress. Skipping.');
            }
            return;
        }

        this.isSyncing = true;
        if (process.env.NODE_ENV === 'development') {
            console.log(`[SYNC-DEBUG] Starting index sync for all ${indexedCodebases.length} codebases...`);
        }

        try {
            let totalStats = { added: 0, removed: 0, modified: 0 };

            for (let i = 0; i < indexedCodebases.length; i++) {
                const codebasePath = indexedCodebases[i];
                const codebaseStartTime = Date.now();

                if (process.env.NODE_ENV === 'development') {
                    console.log(`[SYNC-DEBUG] [${i + 1}/${indexedCodebases.length}] Starting sync for codebase: '${codebasePath}'`);
                }

                // Check if codebase path still exists
                try {
                    const pathExists = fs.existsSync(codebasePath);
                    if (process.env.NODE_ENV === 'development') {
                        console.log(`[SYNC-DEBUG] Codebase path exists: ${pathExists}`);
                    }

                    if (!pathExists) {
                        if (process.env.NODE_ENV === 'development') {
                            console.warn(`[SYNC-DEBUG] Codebase path '${codebasePath}' no longer exists. Skipping sync.`);
                        }
                        continue;
                    }
                } catch (pathError: any) {
                    if (process.env.NODE_ENV === 'development') {
                        console.error(`[SYNC-DEBUG] Error checking codebase path '${codebasePath}':`, pathError);
                    }
                    continue;
                }

                try {
                    if (process.env.NODE_ENV === 'development') {
                        console.log(`[SYNC-DEBUG] Calling context.reindexByChange() for '${codebasePath}'`);
                    }
                    const stats = await this.context.reindexByChange(codebasePath);
                    const codebaseElapsed = Date.now() - codebaseStartTime;

                    if (process.env.NODE_ENV === 'development') {
                        console.log(`[SYNC-DEBUG] Reindex stats for '${codebasePath}':`, stats);
                        console.log(`[SYNC-DEBUG] Codebase sync completed in ${codebaseElapsed}ms`);
                    }

                    // Accumulate total stats
                    totalStats.added += stats.added;
                    totalStats.removed += stats.removed;
                    totalStats.modified += stats.modified;

                    if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                        console.log(`[SYNC] Sync complete for '${codebasePath}'. Added: ${stats.added}, Removed: ${stats.removed}, Modified: ${stats.modified} (${codebaseElapsed}ms)`);
                    } else {
                        console.log(`[SYNC] No changes detected for '${codebasePath}' (${codebaseElapsed}ms)`);
                    }
                } catch (error: any) {
                    const codebaseElapsed = Date.now() - codebaseStartTime;
                    if (process.env.NODE_ENV === 'development') {
                        console.error(`[SYNC-DEBUG] Error syncing codebase '${codebasePath}' after ${codebaseElapsed}ms:`, error);
                        console.error(`[SYNC-DEBUG] Error stack:`, error.stack);
                    }

                    if (error.message.includes('Failed to query Milvus')) {
                        // Collection maybe deleted manually, delete the snapshot file
                        await FileSynchronizer.deleteSnapshot(codebasePath);
                    }

                    // Log additional error details
                    if (error.code) {
                        console.error(`[SYNC-DEBUG] Error code: ${error.code}`);
                    }
                    if (error.errno) {
                        console.error(`[SYNC-DEBUG] Error errno: ${error.errno}`);
                    }

                    // Continue with next codebase even if one fails
                }
            }

            const totalElapsed = Date.now() - syncStartTime;
            console.log(`[SYNC-DEBUG] Total sync stats across all codebases: Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`);
            console.log(`[SYNC-DEBUG] Index sync completed for all codebases in ${totalElapsed}ms`);
            console.log(`[SYNC] Index sync completed for all codebases. Total changes - Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`);
        } catch (error: any) {
            const totalElapsed = Date.now() - syncStartTime;
            console.error(`[SYNC-DEBUG] Error during index sync after ${totalElapsed}ms:`, error);
            console.error(`[SYNC-DEBUG] Error stack:`, error.stack);
        } finally {
            this.isSyncing = false;
            const totalElapsed = Date.now() - syncStartTime;
            console.log(`[SYNC-DEBUG] handleSyncIndex() finished at ${new Date().toISOString()}, total duration: ${totalElapsed}ms`);
        }
    }

    public startBackgroundSync(): void {
        console.log('[SYNC-DEBUG] startBackgroundSync() called');

        // Stop existing sync if running
        if (this.syncIntervalId) {
            console.log('[SYNC-DEBUG] Stopping existing sync interval before starting new one');
            this.stopBackgroundSync();
        }

        // Execute initial sync immediately after a short delay to let server initialize
        console.log('[SYNC-DEBUG] Scheduling initial sync in 5 seconds...');
        setTimeout(async () => {
            console.log('[SYNC-DEBUG] Executing initial sync after server startup');
            try {
                await this.handleSyncIndex();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                if (errorMessage.includes('Failed to query collection')) {
                    console.log('[SYNC-DEBUG] Collection not yet established, this is expected for new cluster users. Will retry on next sync cycle.');
                } else {
                    console.error('[SYNC-DEBUG] Initial sync failed with unexpected error:', error);
                    console.error('[SYNC-DEBUG] This error will not stop the MCP server. Sync will retry on next cycle.');
                }
            }
        }, 5000); // Initial sync after 5 seconds

        // Periodically check for file changes and update the index
        console.log('[SYNC-DEBUG] Setting up periodic sync every 5 minutes (300000ms)');
        this.syncIntervalId = setInterval(() => {
            console.log('[SYNC-DEBUG] Executing scheduled periodic sync');
            this.handleSyncIndex();
        }, 5 * 60 * 1000); // every 5 minutes

        console.log('[SYNC-DEBUG] Background sync setup complete. Interval ID:', this.syncIntervalId);
    }

    public stopBackgroundSync(): void {
        if (this.syncIntervalId) {
            console.log('[SYNC-DEBUG] Stopping background sync. Interval ID:', this.syncIntervalId);
            clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
            console.log('[SYNC-DEBUG] Background sync stopped successfully');
        } else {
            console.log('[SYNC-DEBUG] No active sync to stop');
        }
    }

    public isBackgroundSyncActive(): boolean {
        return this.syncIntervalId !== null;
    }
} 