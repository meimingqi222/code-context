import pLimit from 'p-limit';

// Interface definitions
export interface EmbeddingVector {
    vector: number[];
    dimension: number;
}

/**
 * Options for batch embedding with concurrency control
 */
export interface BatchEmbeddingOptions {
    /** Batch size for each API call (default: 100) */
    batchSize?: number;
    /** Number of concurrent batch requests (default: 3) */
    concurrency?: number;
    /** Enable performance monitoring (default: false) */
    enableMonitoring?: boolean;
}

/**
 * Performance metrics for embedding operations
 */
export interface EmbeddingMetrics {
    totalTexts: number;
    totalBatches: number;
    totalTimeMs: number;
    avgBatchTimeMs: number;
    textsPerSecond: number;
    concurrencyUsed: number;
}

/**
| * Abstract base class for embedding implementations
| */
export abstract class Embedding {
    protected abstract maxTokens: number;
    protected metrics: EmbeddingMetrics | null = null;

    /**
     * Preprocess text to ensure it's valid for embedding
     * @param text Input text
     * @returns Processed text
     */
    protected preprocessText(text: string): string {
        // Replace empty string with single space
        if (text === '') {
            return ' ';
        }

        // Simple character-based truncation (approximation)
        // Each token is roughly 4 characters on average for English text
        const maxChars = this.maxTokens * 4;
        if (text.length > maxChars) {
            return text.substring(0, maxChars);
        }

        return text;
    }

    /**
     * Detect embedding dimension 
     * @param testText Test text for dimension detection
     * @returns Embedding dimension
     */
    abstract detectDimension(testText?: string): Promise<number>;

    /**
     * Preprocess array of texts
     * @param texts Array of input texts
     * @returns Array of processed texts
     */
    protected preprocessTexts(texts: string[]): string[] {
        return texts.map(text => this.preprocessText(text));
    }

    /**
     * Split array into chunks of specified size
     * @param array Array to split
     * @param chunkSize Size of each chunk
     * @returns Array of chunks
     */
    protected chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * Process embeddings with concurrency control
     * This provides a default implementation that can be overridden
     * @param texts Array of texts to embed
     * @param options Batch processing options
     * @returns Array of embedding vectors
     */
    async embedBatchWithConcurrency(
        texts: string[], 
        options?: BatchEmbeddingOptions
    ): Promise<EmbeddingVector[]> {
        const {
            batchSize = 100,
            concurrency = 3,
            enableMonitoring = false
        } = options || {};

        const startTime = Date.now();
        const preprocessedTexts = this.preprocessTexts(texts);
        const batches = this.chunkArray(preprocessedTexts, batchSize);

        if (enableMonitoring) {
            console.log(`[Embedding] Processing ${texts.length} texts in ${batches.length} batches with concurrency ${concurrency}`);
        }

        // Use p-limit to control concurrency
        const limit = pLimit(concurrency);
        const batchPromises = batches.map((batch, index) => 
            limit(async () => {
                const batchStart = Date.now();
                try {
                    const result = await this.embedBatch(batch);
                    if (enableMonitoring) {
                        const batchTime = Date.now() - batchStart;
                        console.log(`[Embedding] Batch ${index + 1}/${batches.length} completed in ${batchTime}ms (${batch.length} texts)`);
                    }
                    return result;
                } catch (error) {
                    console.error(`[Embedding] Batch ${index + 1}/${batches.length} failed:`, error);
                    throw error;
                }
            })
        );

        const batchResults = await Promise.all(batchPromises);
        const results = batchResults.flat();

        const totalTime = Date.now() - startTime;
        if (enableMonitoring) {
            const avgBatchTime = totalTime / batches.length;
            const textsPerSecond = (texts.length / totalTime) * 1000;
            console.log(`[Embedding] ✅ Completed ${texts.length} embeddings in ${(totalTime / 1000).toFixed(2)}s`);
            console.log(`[Embedding] ⚡ Throughput: ${textsPerSecond.toFixed(2)} texts/sec`);
            console.log(`[Embedding] 📊 Avg batch time: ${avgBatchTime.toFixed(2)}ms`);
            
            this.metrics = {
                totalTexts: texts.length,
                totalBatches: batches.length,
                totalTimeMs: totalTime,
                avgBatchTimeMs: avgBatchTime,
                textsPerSecond: textsPerSecond,
                concurrencyUsed: concurrency
            };
        }

        return results;
    }

    /**
     * Get last recorded metrics from embedding operations
     * @returns Metrics object or null if monitoring was not enabled
     */
    getMetrics(): EmbeddingMetrics | null {
        return this.metrics;
    }

    /**
     * Reset metrics
     */
    resetMetrics(): void {
        this.metrics = null;
    }

    // Abstract methods that must be implemented by subclasses
    /**
     * Generate text embedding vector
     * @param text Text content
     * @returns Embedding vector
     */
    abstract embed(text: string): Promise<EmbeddingVector>;

    /**
     * Generate text embedding vectors in batch
     * @param texts Text array
     * @returns Embedding vector array
     */
    abstract embedBatch(texts: string[]): Promise<EmbeddingVector[]>;

    /**
     * Get embedding vector dimension
     * @returns Vector dimension
     */
    abstract getDimension(): number;

    /**
     * Get service provider name
     * @returns Provider name
     */
    abstract getProvider(): string;
}
