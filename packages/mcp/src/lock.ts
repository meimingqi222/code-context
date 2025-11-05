import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from './logger.js';

export interface LockOptions {
    /**
     * Lock timeout in milliseconds
     * If a lock file is older than this, it's considered stale
     */
    timeout?: number;
    
    /**
     * Retry interval in milliseconds when waiting for lock
     */
    retryInterval?: number;
    
    /**
     * Maximum retry attempts
     */
    maxRetries?: number;
}

export interface LockInfo {
    pid: number;
    startTime: number;
    hostname: string;
}

/**
 * Process lock manager to coordinate between multiple MCP instances
 * 
 * This prevents multiple agent processes from simultaneously:
 * - Indexing the same codebase
 * - Running background sync for the same codebase
 * - Calling Ollama/embedding APIs redundantly
 */
export class ProcessLockManager {
    private lockDir: string;
    private logger = getLogger();
    private activeLocks = new Map<string, string>(); // Map of resource name to lock file path
    
    constructor(lockDir?: string) {
        // Use a centralized lock directory
        this.lockDir = lockDir || path.join(os.homedir(), '.context', 'locks');
        
        // Ensure lock directory exists
        if (!fs.existsSync(this.lockDir)) {
            fs.mkdirSync(this.lockDir, { recursive: true });
        }
        
        // Clean up stale locks on startup
        this.cleanupStaleLocks();
        
        // Register cleanup on process exit
        this.registerCleanupHandlers();
    }
    
    /**
     * Get lock file path for a resource
     */
    private getLockPath(resourceName: string): string {
        // Create a safe filename from resource name (e.g., codebase path)
        const hash = require('crypto')
            .createHash('md5')
            .update(resourceName)
            .digest('hex');
        return path.join(this.lockDir, `${hash}.lock`);
    }
    
    /**
     * Check if a lock file is stale (process no longer exists or too old)
     */
    private isLockStale(lockPath: string, timeout: number = 30 * 60 * 1000): boolean {
        try {
            if (!fs.existsSync(lockPath)) {
                return true;
            }
            
            const lockContent = fs.readFileSync(lockPath, 'utf8');
            const lockInfo: LockInfo = JSON.parse(lockContent);
            
            // Check if lock is too old
            const age = Date.now() - lockInfo.startTime;
            if (age > timeout) {
                this.logger.file(`[LOCK] Lock is stale (age: ${Math.floor(age / 1000)}s, timeout: ${Math.floor(timeout / 1000)}s)`);
                return true;
            }
            
            // Check if process still exists (Unix only)
            if (process.platform !== 'win32') {
                try {
                    // Signal 0 checks if process exists without actually sending a signal
                    process.kill(lockInfo.pid, 0);
                    return false; // Process exists, lock is valid
                } catch (e) {
                    // Process doesn't exist
                    this.logger.file(`[LOCK] Lock owner process (PID ${lockInfo.pid}) no longer exists`);
                    return true;
                }
            }
            
            return false; // On Windows, assume lock is valid if not too old
        } catch (error) {
            this.logger.file(`[LOCK] Error checking lock staleness: ${error}`);
            return true; // Treat as stale if we can't read it
        }
    }
    
    /**
     * Clean up stale lock files
     */
    private cleanupStaleLocks(): void {
        try {
            if (!fs.existsSync(this.lockDir)) {
                return;
            }
            
            const lockFiles = fs.readdirSync(this.lockDir).filter(f => f.endsWith('.lock'));
            let cleaned = 0;
            
            for (const lockFile of lockFiles) {
                const lockPath = path.join(this.lockDir, lockFile);
                if (this.isLockStale(lockPath)) {
                    try {
                        fs.unlinkSync(lockPath);
                        cleaned++;
                        this.logger.file(`[LOCK] Cleaned up stale lock: ${lockFile}`);
                    } catch (error) {
                        this.logger.file(`[LOCK] Failed to clean up stale lock ${lockFile}: ${error}`);
                    }
                }
            }
            
            if (cleaned > 0) {
                this.logger.file(`[LOCK] Cleaned up ${cleaned} stale lock(s) on startup`);
            }
        } catch (error) {
            this.logger.file(`[LOCK] Error during stale lock cleanup: ${error}`);
        }
    }
    
    /**
     * Try to acquire a lock for a resource
     * 
     * @param resourceName - Unique identifier for the resource (e.g., codebase path)
     * @param options - Lock options
     * @returns true if lock acquired, false otherwise
     */
    public async tryAcquireLock(
        resourceName: string,
        options: LockOptions = {}
    ): Promise<boolean> {
        const {
            timeout = 30 * 60 * 1000, // 30 minutes default
            retryInterval = 1000,
            maxRetries = 0 // Don't retry by default
        } = options;
        
        const lockPath = this.getLockPath(resourceName);
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Check if lock exists and is valid
                if (fs.existsSync(lockPath)) {
                    if (this.isLockStale(lockPath, timeout)) {
                        // Remove stale lock
                        fs.unlinkSync(lockPath);
                        this.logger.file(`[LOCK] Removed stale lock for: ${resourceName}`);
                    } else {
                        // Lock is held by another process
                        const lockContent = fs.readFileSync(lockPath, 'utf8');
                        const lockInfo: LockInfo = JSON.parse(lockContent);
                        
                        this.logger.file(
                            `[LOCK] Resource '${resourceName}' is locked by PID ${lockInfo.pid} ` +
                            `on ${lockInfo.hostname} (age: ${Math.floor((Date.now() - lockInfo.startTime) / 1000)}s)`
                        );
                        
                        if (attempt < maxRetries) {
                            this.logger.file(`[LOCK] Retrying in ${retryInterval}ms... (attempt ${attempt + 1}/${maxRetries})`);
                            await new Promise(resolve => setTimeout(resolve, retryInterval));
                            continue;
                        }
                        
                        return false;
                    }
                }
                
                // Try to create lock file
                const lockInfo: LockInfo = {
                    pid: process.pid,
                    startTime: Date.now(),
                    hostname: os.hostname()
                };
                
                // Use 'wx' flag to ensure atomic create (fails if file exists)
                fs.writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2), { flag: 'wx' });
                
                // Track active lock for cleanup
                this.activeLocks.set(resourceName, lockPath);
                
                this.logger.file(`[LOCK] Successfully acquired lock for: ${resourceName} (PID ${process.pid})`);
                return true;
                
            } catch (error: any) {
                if (error.code === 'EEXIST') {
                    // Another process created the lock between our check and write
                    if (attempt < maxRetries) {
                        this.logger.file(`[LOCK] Lock race condition, retrying... (attempt ${attempt + 1}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, retryInterval));
                        continue;
                    }
                    return false;
                }
                
                this.logger.file(`[LOCK] Error acquiring lock for ${resourceName}: ${error}`);
                return false;
            }
        }
        
        return false;
    }
    
    /**
     * Release a lock for a resource
     */
    public releaseLock(resourceName: string): void {
        const lockPath = this.getLockPath(resourceName);
        
        try {
            if (fs.existsSync(lockPath)) {
                // Verify we own this lock
                const lockContent = fs.readFileSync(lockPath, 'utf8');
                const lockInfo: LockInfo = JSON.parse(lockContent);
                
                if (lockInfo.pid === process.pid) {
                    fs.unlinkSync(lockPath);
                    this.activeLocks.delete(resourceName);
                    this.logger.file(`[LOCK] Released lock for: ${resourceName} (PID ${process.pid})`);
                } else {
                    this.logger.file(
                        `[LOCK] Cannot release lock for ${resourceName}: owned by PID ${lockInfo.pid}, not ${process.pid}`
                    );
                }
            }
        } catch (error) {
            this.logger.file(`[LOCK] Error releasing lock for ${resourceName}: ${error}`);
        }
    }
    
    /**
     * Check if a resource is currently locked
     */
    public isLocked(resourceName: string, timeout?: number): boolean {
        const lockPath = this.getLockPath(resourceName);
        
        if (!fs.existsSync(lockPath)) {
            return false;
        }
        
        return !this.isLockStale(lockPath, timeout);
    }
    
    /**
     * Get information about who holds a lock
     */
    public getLockInfo(resourceName: string): LockInfo | null {
        const lockPath = this.getLockPath(resourceName);
        
        try {
            if (!fs.existsSync(lockPath)) {
                return null;
            }
            
            const lockContent = fs.readFileSync(lockPath, 'utf8');
            const lockInfo: LockInfo = JSON.parse(lockContent);
            return lockInfo;
        } catch (error) {
            this.logger.file(`[LOCK] Error reading lock info for ${resourceName}: ${error}`);
            return null;
        }
    }
    
    /**
     * Execute a function with exclusive lock
     */
    public async withLock<T>(
        resourceName: string,
        fn: () => Promise<T>,
        options: LockOptions = {}
    ): Promise<{ success: boolean; result?: T; error?: Error; lockedByOther?: boolean }> {
        const acquired = await this.tryAcquireLock(resourceName, options);
        
        if (!acquired) {
            return { success: false, lockedByOther: true };
        }
        
        try {
            const result = await fn();
            return { success: true, result };
        } catch (error) {
            return { success: false, error: error as Error };
        } finally {
            this.releaseLock(resourceName);
        }
    }
    
    /**
     * Release all locks held by this process
     */
    private releaseAllLocks(): void {
        for (const [resourceName, lockPath] of this.activeLocks) {
            try {
                if (fs.existsSync(lockPath)) {
                    fs.unlinkSync(lockPath);
                    this.logger.file(`[LOCK] Released lock on exit: ${resourceName}`);
                }
            } catch (error) {
                this.logger.file(`[LOCK] Error releasing lock on exit for ${resourceName}: ${error}`);
            }
        }
        this.activeLocks.clear();
    }
    
    /**
     * Register cleanup handlers for process exit
     */
    private registerCleanupHandlers(): void {
        const cleanup = () => {
            this.releaseAllLocks();
        };
        
        // Don't re-register if already registered
        if ((this as any)._cleanupRegistered) {
            return;
        }
        (this as any)._cleanupRegistered = true;
        
        process.on('exit', cleanup);
        process.on('SIGINT', () => {
            cleanup();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            cleanup();
            process.exit(0);
        });
        process.on('uncaughtException', (error) => {
            this.logger.file(`[LOCK] Uncaught exception, releasing locks: ${error}`);
            cleanup();
        });
    }
}

// Singleton instance
let globalLockManager: ProcessLockManager | null = null;

/**
 * Get the global lock manager instance
 */
export function getLockManager(): ProcessLockManager {
    if (!globalLockManager) {
        globalLockManager = new ProcessLockManager();
    }
    return globalLockManager;
}

/**
 * Semaphore for limiting concurrent operations across processes
 * Uses file-based counting to coordinate between multiple MCP processes
 */
export class ProcessSemaphore {
    private semaphoreDir: string;
    private maxConcurrent: number;
    private logger = getLogger();
    
    constructor(name: string, maxConcurrent: number = 2, baseDir?: string) {
        this.maxConcurrent = maxConcurrent;
        const lockDir = baseDir || path.join(os.homedir(), '.context', 'locks');
        this.semaphoreDir = path.join(lockDir, `semaphore-${name}`);
        
        // Ensure semaphore directory exists
        if (!fs.existsSync(this.semaphoreDir)) {
            fs.mkdirSync(this.semaphoreDir, { recursive: true });
        }
        
        // Clean up stale slots on initialization
        this.cleanupStaleSlots();
    }
    
    /**
     * Get slot file path for a process
     */
    private getSlotPath(slotId: number): string {
        return path.join(this.semaphoreDir, `slot-${slotId}.lock`);
    }
    
    /**
     * Check if a slot is stale
     */
    private isSlotStale(slotPath: string, timeout: number = 2 * 60 * 60 * 1000): boolean {
        try {
            if (!fs.existsSync(slotPath)) {
                return true;
            }
            
            const lockContent = fs.readFileSync(slotPath, 'utf8');
            const lockInfo: LockInfo = JSON.parse(lockContent);
            
            // Check timeout
            if (Date.now() - lockInfo.startTime > timeout) {
                return true;
            }
            
            // Check if process exists (Unix only)
            if (process.platform !== 'win32') {
                try {
                    process.kill(lockInfo.pid, 0);
                    return false;
                } catch {
                    return true;
                }
            }
            
            return false;
        } catch {
            return true;
        }
    }
    
    /**
     * Clean up stale semaphore slots
     */
    private cleanupStaleSlots(): void {
        try {
            if (!fs.existsSync(this.semaphoreDir)) {
                return;
            }
            
            const slots = fs.readdirSync(this.semaphoreDir).filter(f => f.startsWith('slot-'));
            let cleaned = 0;
            
            for (const slotFile of slots) {
                const slotPath = path.join(this.semaphoreDir, slotFile);
                if (this.isSlotStale(slotPath)) {
                    try {
                        fs.unlinkSync(slotPath);
                        cleaned++;
                    } catch {}
                }
            }
            
            if (cleaned > 0) {
                this.logger.file(`[SEMAPHORE] Cleaned up ${cleaned} stale slot(s)`);
            }
        } catch (error) {
            this.logger.file(`[SEMAPHORE] Error cleaning up stale slots: ${error}`);
        }
    }
    
    /**
     * Try to acquire a semaphore slot
     * 
     * @returns slot ID if acquired, null if no slots available
     */
    public async tryAcquire(options: { timeout?: number; maxRetries?: number; retryInterval?: number } = {}): Promise<number | null> {
        const {
            timeout = 2 * 60 * 60 * 1000, // 2 hours default
            maxRetries = 0,
            retryInterval = 1000
        } = options;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // Try to acquire any available slot
            for (let slotId = 0; slotId < this.maxConcurrent; slotId++) {
                const slotPath = this.getSlotPath(slotId);
                
                // Check if slot is available or stale
                if (fs.existsSync(slotPath) && !this.isSlotStale(slotPath, timeout)) {
                    continue; // Slot occupied
                }
                
                // Try to acquire this slot
                try {
                    // Clean up stale slot first
                    if (fs.existsSync(slotPath)) {
                        fs.unlinkSync(slotPath);
                    }
                    
                    const lockInfo: LockInfo = {
                        pid: process.pid,
                        startTime: Date.now(),
                        hostname: os.hostname()
                    };
                    
                    fs.writeFileSync(slotPath, JSON.stringify(lockInfo, null, 2), { flag: 'wx' });
                    this.logger.file(`[SEMAPHORE] Acquired slot ${slotId}/${this.maxConcurrent} (PID ${process.pid})`);
                    return slotId;
                } catch (error: any) {
                    if (error.code === 'EEXIST') {
                        // Race condition, someone else got it
                        continue;
                    }
                    this.logger.file(`[SEMAPHORE] Error acquiring slot ${slotId}: ${error}`);
                }
            }
            
            // No slots available
            if (attempt < maxRetries) {
                this.logger.file(`[SEMAPHORE] All ${this.maxConcurrent} slots occupied, retrying in ${retryInterval}ms...`);
                await new Promise(resolve => setTimeout(resolve, retryInterval));
            }
        }
        
        // Get info about who holds the slots
        const occupiedSlots = this.getOccupiedSlots();
        this.logger.file(
            `[SEMAPHORE] Failed to acquire slot. ${occupiedSlots.length}/${this.maxConcurrent} slots occupied by: ` +
            occupiedSlots.map(s => `PID ${s.info.pid}`).join(', ')
        );
        
        return null;
    }
    
    /**
     * Release a semaphore slot
     */
    public release(slotId: number): void {
        const slotPath = this.getSlotPath(slotId);
        
        try {
            if (fs.existsSync(slotPath)) {
                const lockContent = fs.readFileSync(slotPath, 'utf8');
                const lockInfo: LockInfo = JSON.parse(lockContent);
                
                if (lockInfo.pid === process.pid) {
                    fs.unlinkSync(slotPath);
                    this.logger.file(`[SEMAPHORE] Released slot ${slotId} (PID ${process.pid})`);
                } else {
                    this.logger.file(
                        `[SEMAPHORE] Cannot release slot ${slotId}: owned by PID ${lockInfo.pid}, not ${process.pid}`
                    );
                }
            }
        } catch (error) {
            this.logger.file(`[SEMAPHORE] Error releasing slot ${slotId}: ${error}`);
        }
    }
    
    /**
     * Get currently occupied slots
     */
    public getOccupiedSlots(): Array<{ slotId: number; info: LockInfo }> {
        const occupied: Array<{ slotId: number; info: LockInfo }> = [];
        
        try {
            for (let slotId = 0; slotId < this.maxConcurrent; slotId++) {
                const slotPath = this.getSlotPath(slotId);
                
                if (fs.existsSync(slotPath) && !this.isSlotStale(slotPath)) {
                    try {
                        const lockContent = fs.readFileSync(slotPath, 'utf8');
                        const lockInfo: LockInfo = JSON.parse(lockContent);
                        occupied.push({ slotId, info: lockInfo });
                    } catch {}
                }
            }
        } catch (error) {
            this.logger.file(`[SEMAPHORE] Error getting occupied slots: ${error}`);
        }
        
        return occupied;
    }
    
    /**
     * Get number of available slots
     */
    public getAvailableSlots(): number {
        return this.maxConcurrent - this.getOccupiedSlots().length;
    }
    
    /**
     * Execute function with semaphore
     */
    public async withSemaphore<T>(
        fn: () => Promise<T>,
        options: { timeout?: number; maxRetries?: number; retryInterval?: number } = {}
    ): Promise<{ success: boolean; result?: T; error?: Error; noSlots?: boolean }> {
        const slotId = await this.tryAcquire(options);
        
        if (slotId === null) {
            return { success: false, noSlots: true };
        }
        
        try {
            const result = await fn();
            return { success: true, result };
        } catch (error) {
            return { success: false, error: error as Error };
        } finally {
            this.release(slotId);
        }
    }
}

// Global semaphore for indexing operations
let globalIndexingSemaphore: ProcessSemaphore | null = null;

/**
 * Get the global indexing semaphore
 * Default: max 2 concurrent indexing operations
 */
export function getIndexingSemaphore(maxConcurrent: number = 2): ProcessSemaphore {
    if (!globalIndexingSemaphore) {
        globalIndexingSemaphore = new ProcessSemaphore('indexing', maxConcurrent);
    }
    return globalIndexingSemaphore;
}
