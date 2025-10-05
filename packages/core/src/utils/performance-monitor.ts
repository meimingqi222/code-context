/**
 * Performance monitoring utility for tracking indexing performance
 */

export interface PerformanceMetrics {
    // Timing metrics
    totalTimeMs: number;
    embeddingTimeMs: number;
    dbInsertTimeMs: number;
    fileReadTimeMs: number;
    
    // Throughput metrics
    chunksPerSecond: number;
    filesPerSecond: number;
    embeddingsPerSecond: number;
    dbInsertsPerSecond: number;
    
    // Count metrics
    totalFiles: number;
    totalChunks: number;
    totalEmbeddingBatches: number;
    totalDbInserts: number;
    
    // Memory metrics
    peakMemoryMB: number;
    avgMemoryMB: number;
    gcCount: number;
    
    // Parallelism metrics
    avgConcurrentEmbeddings: number;
    avgConcurrentDbInserts: number;
    pipelineOverlapPercentage: number;
}

export class PerformanceMonitor {
    private startTime: number = 0;
    private endTime: number = 0;
    
    // Timing accumulators
    private embeddingTime: number = 0;
    private dbInsertTime: number = 0;
    private fileReadTime: number = 0;
    
    // Count accumulators
    private filesProcessed: number = 0;
    private chunksProcessed: number = 0;
    private embeddingBatches: number = 0;
    private dbInserts: number = 0;
    
    // Memory tracking
    private memoryReadings: number[] = [];
    private gcCount: number = 0;
    
    // Concurrency tracking
    private concurrentEmbeddings: number[] = [];
    private concurrentDbInserts: number[] = [];
    private embeddingStageActive: number = 0;
    private dbStageActive: number = 0;
    private overlapSamples: number = 0;
    private overlapCount: number = 0;
    
    constructor() {
        this.reset();
    }
    
    reset(): void {
        this.startTime = Date.now();
        this.endTime = 0;
        this.embeddingTime = 0;
        this.dbInsertTime = 0;
        this.fileReadTime = 0;
        this.filesProcessed = 0;
        this.chunksProcessed = 0;
        this.embeddingBatches = 0;
        this.dbInserts = 0;
        this.memoryReadings = [];
        this.gcCount = 0;
        this.concurrentEmbeddings = [];
        this.concurrentDbInserts = [];
        this.embeddingStageActive = 0;
        this.dbStageActive = 0;
        this.overlapSamples = 0;
        this.overlapCount = 0;
    }
    
    start(): void {
        this.startTime = Date.now();
    }
    
    finish(): void {
        this.endTime = Date.now();
    }
    
    recordFileRead(durationMs: number, fileCount: number = 1): void {
        this.fileReadTime += durationMs;
        this.filesProcessed += fileCount;
    }
    
    recordEmbeddingBatch(durationMs: number, chunkCount: number): void {
        this.embeddingTime += durationMs;
        this.embeddingBatches++;
        this.chunksProcessed += chunkCount;
    }
    
    recordDbInsert(durationMs: number, documentCount: number): void {
        this.dbInsertTime += durationMs;
        this.dbInserts++;
    }
    
    recordMemory(memoryMB: number): void {
        this.memoryReadings.push(memoryMB);
    }
    
    recordGC(): void {
        this.gcCount++;
    }
    
    recordConcurrentEmbeddings(count: number): void {
        this.concurrentEmbeddings.push(count);
    }
    
    recordConcurrentDbInserts(count: number): void {
        this.concurrentDbInserts.push(count);
    }
    
    markEmbeddingStageStart(): void {
        this.embeddingStageActive++;
        this.checkOverlap();
    }
    
    markEmbeddingStageEnd(): void {
        this.embeddingStageActive = Math.max(0, this.embeddingStageActive - 1);
    }
    
    markDbStageStart(): void {
        this.dbStageActive++;
        this.checkOverlap();
    }
    
    markDbStageEnd(): void {
        this.dbStageActive = Math.max(0, this.dbStageActive - 1);
    }
    
    private checkOverlap(): void {
        this.overlapSamples++;
        if (this.embeddingStageActive > 0 && this.dbStageActive > 0) {
            this.overlapCount++;
        }
    }
    
    getMetrics(): PerformanceMetrics {
        const totalTime = this.endTime > 0 ? this.endTime - this.startTime : Date.now() - this.startTime;
        const totalTimeSec = totalTime / 1000;
        
        const peakMemory = this.memoryReadings.length > 0 ? Math.max(...this.memoryReadings) : 0;
        const avgMemory = this.memoryReadings.length > 0 
            ? this.memoryReadings.reduce((a, b) => a + b, 0) / this.memoryReadings.length 
            : 0;
        
        const avgConcurrentEmbeddings = this.concurrentEmbeddings.length > 0
            ? this.concurrentEmbeddings.reduce((a, b) => a + b, 0) / this.concurrentEmbeddings.length
            : 0;
        
        const avgConcurrentDbInserts = this.concurrentDbInserts.length > 0
            ? this.concurrentDbInserts.reduce((a, b) => a + b, 0) / this.concurrentDbInserts.length
            : 0;
        
        const pipelineOverlap = this.overlapSamples > 0
            ? (this.overlapCount / this.overlapSamples) * 100
            : 0;
        
        return {
            totalTimeMs: totalTime,
            embeddingTimeMs: this.embeddingTime,
            dbInsertTimeMs: this.dbInsertTime,
            fileReadTimeMs: this.fileReadTime,
            
            chunksPerSecond: this.chunksProcessed / totalTimeSec,
            filesPerSecond: this.filesProcessed / totalTimeSec,
            embeddingsPerSecond: this.embeddingBatches / totalTimeSec,
            dbInsertsPerSecond: this.dbInserts / totalTimeSec,
            
            totalFiles: this.filesProcessed,
            totalChunks: this.chunksProcessed,
            totalEmbeddingBatches: this.embeddingBatches,
            totalDbInserts: this.dbInserts,
            
            peakMemoryMB: peakMemory,
            avgMemoryMB: avgMemory,
            gcCount: this.gcCount,
            
            avgConcurrentEmbeddings: avgConcurrentEmbeddings,
            avgConcurrentDbInserts: avgConcurrentDbInserts,
            pipelineOverlapPercentage: pipelineOverlap
        };
    }
    
    printSummary(): void {
        const metrics = this.getMetrics();
        
        console.log('\n' + '='.repeat(80));
        console.log('🎯 PERFORMANCE SUMMARY');
        console.log('='.repeat(80));
        
        console.log('\n📊 Timing Metrics:');
        console.log(`  Total Time:        ${(metrics.totalTimeMs / 1000).toFixed(2)}s`);
        console.log(`  Embedding Time:    ${(metrics.embeddingTimeMs / 1000).toFixed(2)}s (${((metrics.embeddingTimeMs / metrics.totalTimeMs) * 100).toFixed(1)}%)`);
        console.log(`  DB Insert Time:    ${(metrics.dbInsertTimeMs / 1000).toFixed(2)}s (${((metrics.dbInsertTimeMs / metrics.totalTimeMs) * 100).toFixed(1)}%)`);
        console.log(`  File Read Time:    ${(metrics.fileReadTimeMs / 1000).toFixed(2)}s (${((metrics.fileReadTimeMs / metrics.totalTimeMs) * 100).toFixed(1)}%)`);
        
        console.log('\n⚡ Throughput Metrics:');
        console.log(`  Chunks/Second:     ${metrics.chunksPerSecond.toFixed(2)}`);
        console.log(`  Files/Second:      ${metrics.filesPerSecond.toFixed(2)}`);
        console.log(`  Embeddings/Second: ${metrics.embeddingsPerSecond.toFixed(2)}`);
        console.log(`  DB Inserts/Second: ${metrics.dbInsertsPerSecond.toFixed(2)}`);
        
        console.log('\n📈 Count Metrics:');
        console.log(`  Total Files:       ${metrics.totalFiles}`);
        console.log(`  Total Chunks:      ${metrics.totalChunks}`);
        console.log(`  Embedding Batches: ${metrics.totalEmbeddingBatches}`);
        console.log(`  DB Inserts:        ${metrics.totalDbInserts}`);
        
        console.log('\n💾 Memory Metrics:');
        console.log(`  Peak Memory:       ${metrics.peakMemoryMB.toFixed(0)}MB`);
        console.log(`  Avg Memory:        ${metrics.avgMemoryMB.toFixed(0)}MB`);
        console.log(`  GC Collections:    ${metrics.gcCount}`);
        
        console.log('\n🔀 Parallelism Metrics:');
        console.log(`  Avg Concurrent Embeddings: ${metrics.avgConcurrentEmbeddings.toFixed(2)}`);
        console.log(`  Avg Concurrent DB Inserts: ${metrics.avgConcurrentDbInserts.toFixed(2)}`);
        console.log(`  Pipeline Overlap:          ${metrics.pipelineOverlapPercentage.toFixed(1)}%`);
        
        console.log('\n' + '='.repeat(80) + '\n');
    }
}
