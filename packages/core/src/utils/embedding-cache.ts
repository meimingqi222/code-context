import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EmbeddingVector } from '../embedding/base-embedding';

/**
 * Cache entry structure
 */
interface CacheEntry {
    hash: string;
    vectors: EmbeddingVector[];
    timestamp: number;
    accessCount: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
    hits: number;
    misses: number;
    size: number;
    hitRate: number;
    totalSavedEmbeddings: number;
}

/**
 * Embedding cache manager with LRU eviction
 */
export class EmbeddingCache {
    private cache: Map<string, CacheEntry> = new Map();
    private maxSize: number;
    private maxAgeMs: number;
    private persistPath: string;
    
    // Statistics
    private hits: number = 0;
    private misses: number = 0;
    
    constructor(options?: {
        maxSize?: number;
        maxAgeMs?: number;
        persistPath?: string;
    }) {
        this.maxSize = options?.maxSize || 10000; // Default: 10k entries
        this.maxAgeMs = options?.maxAgeMs || 7 * 24 * 60 * 60 * 1000; // Default: 7 days
        this.persistPath = options?.persistPath || path.join(os.homedir(), '.context', 'embedding-cache.json');
    }
    
    /**
     * Generate hash for content
     */
    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }
    
    /**
     * Get embedding from cache
     */
    get(content: string): EmbeddingVector[] | null {
        const hash = this.hashContent(content);
        const entry = this.cache.get(hash);
        
        if (!entry) {
            this.misses++;
            return null;
        }
        
        // Check if entry is expired
        if (Date.now() - entry.timestamp > this.maxAgeMs) {
            this.cache.delete(hash);
            this.misses++;
            return null;
        }
        
        // Update access count and timestamp (LRU)
        entry.accessCount++;
        entry.timestamp = Date.now();
        this.hits++;
        
        return entry.vectors;
    }
    
    /**
     * Set embedding in cache
     */
    set(content: string, vectors: EmbeddingVector[]): void {
        const hash = this.hashContent(content);
        
        // Evict if cache is full
        if (this.cache.size >= this.maxSize) {
            this.evictLRU();
        }
        
        this.cache.set(hash, {
            hash,
            vectors,
            timestamp: Date.now(),
            accessCount: 1
        });
    }
    
    /**
     * Evict least recently used entry
     */
    private evictLRU(): void {
        let oldestEntry: [string, CacheEntry] | null = null;
        let oldestTimestamp = Date.now();
        
        for (const [key, entry] of this.cache.entries()) {
            if (entry.timestamp < oldestTimestamp) {
                oldestTimestamp = entry.timestamp;
                oldestEntry = [key, entry];
            }
        }
        
        if (oldestEntry) {
            this.cache.delete(oldestEntry[0]);
        }
    }
    
    /**
     * Clear all cache entries
     */
    clear(): void {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }
    
    /**
     * Get cache statistics
     */
    getStats(): CacheStats {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            size: this.cache.size,
            hitRate: total > 0 ? this.hits / total : 0,
            totalSavedEmbeddings: this.hits
        };
    }
    
    /**
     * Print cache statistics
     */
    printStats(): void {
        const stats = this.getStats();
        console.log('\n' + '='.repeat(60));
        console.log('📊 EMBEDDING CACHE STATISTICS');
        console.log('='.repeat(60));
        console.log(`Cache Hits:        ${stats.hits}`);
        console.log(`Cache Misses:      ${stats.misses}`);
        console.log(`Hit Rate:          ${(stats.hitRate * 100).toFixed(2)}%`);
        console.log(`Cache Size:        ${stats.size}/${this.maxSize}`);
        console.log(`Saved Embeddings:  ${stats.totalSavedEmbeddings}`);
        console.log('='.repeat(60) + '\n');
    }
    
    /**
     * Persist cache to disk
     */
    async persist(): Promise<void> {
        try {
            const cacheData = Array.from(this.cache.entries()).map(([key, entry]) => ({
                key,
                ...entry
            }));
            
            // Ensure directory exists
            await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
            
            // Write cache to disk
            await fs.writeFile(
                this.persistPath,
                JSON.stringify(cacheData, null, 2),
                'utf8'
            );
            
            console.log(`[EmbeddingCache] ✅ Persisted ${cacheData.length} entries to ${this.persistPath}`);
        } catch (error) {
            console.error('[EmbeddingCache] ❌ Failed to persist cache:', error);
        }
    }
    
    /**
     * Load cache from disk
     */
    async load(): Promise<void> {
        try {
            const data = await fs.readFile(this.persistPath, 'utf8');
            const cacheData = JSON.parse(data);
            
            let loaded = 0;
            let expired = 0;
            
            for (const item of cacheData) {
                // Skip expired entries
                if (Date.now() - item.timestamp > this.maxAgeMs) {
                    expired++;
                    continue;
                }
                
                this.cache.set(item.key, {
                    hash: item.hash,
                    vectors: item.vectors,
                    timestamp: item.timestamp,
                    accessCount: item.accessCount
                });
                loaded++;
            }
            
            console.log(`[EmbeddingCache] ✅ Loaded ${loaded} entries from disk (${expired} expired)`);
        } catch (error) {
            if ((error as any).code !== 'ENOENT') {
                console.error('[EmbeddingCache] ❌ Failed to load cache:', error);
            }
        }
    }
}
