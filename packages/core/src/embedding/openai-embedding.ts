import OpenAI from 'openai';
import { Embedding, EmbeddingVector } from './base-embedding';

export interface OpenAIEmbeddingConfig {
    model: string;
    apiKey: string;
    baseURL?: string; // OpenAI supports custom baseURL
}

export class OpenAIEmbedding extends Embedding {
    private client: OpenAI;
    private config: OpenAIEmbeddingConfig;
    private dimension: number = 1536; // Default dimension for text-embedding-3-small
    protected maxTokens: number = 8192; // Maximum tokens for OpenAI embedding models

    constructor(config: OpenAIEmbeddingConfig) {
        super();
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
        });
    }

    async detectDimension(testText: string = "test"): Promise<number> {
        const model = this.config.model || 'text-embedding-3-small';
        const knownModels = OpenAIEmbedding.getSupportedModels();

        // Use known dimension for standard models
        if (knownModels[model]) {
            return knownModels[model].dimension;
        }

        // For custom models, make API call to detect dimension
        try {
            const processedText = this.preprocessText(testText);
            
            // Check if using custom baseURL
            const isCustomEndpoint = this.config.baseURL && !this.config.baseURL.includes('api.openai.com');
            
            const requestParams: any = {
                model: model,
                input: processedText,
            };
            
            if (!isCustomEndpoint) {
                requestParams.encoding_format = 'float';
            }
            
            const response = await this.client.embeddings.create(requestParams);
            return response.data[0].embedding.length;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            // Re-throw authentication errors
            if (errorMessage.includes('API key') || errorMessage.includes('unauthorized') || errorMessage.includes('authentication')) {
                throw new Error(`Failed to detect dimension for model ${model}: ${errorMessage}`);
            }

            // For other errors, throw exception instead of using fallback
            throw new Error(`Failed to detect dimension for model ${model}: ${errorMessage}`);
        }
    }

    async embed(text: string): Promise<EmbeddingVector> {
        const processedText = this.preprocessText(text);
        const model = this.config.model || 'text-embedding-3-small';

        const knownModels = OpenAIEmbedding.getSupportedModels();
        if (knownModels[model] && this.dimension !== knownModels[model].dimension) {
            this.dimension = knownModels[model].dimension;
        } else if (!knownModels[model]) {
            this.dimension = await this.detectDimension();
        }

        try {
            // Check if using custom baseURL
            const isCustomEndpoint = this.config.baseURL && !this.config.baseURL.includes('api.openai.com');
            
            const requestParams: any = {
                model: model,
                input: processedText,
            };
            
            if (!isCustomEndpoint) {
                requestParams.encoding_format = 'float';
            }
            
            const response = await this.client.embeddings.create(requestParams);

            // Update dimension from actual response
            this.dimension = response.data[0].embedding.length;

            return {
                vector: response.data[0].embedding,
                dimension: this.dimension
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to generate OpenAI embedding: ${errorMessage}`);
        }
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        // Handle empty array case to prevent API validation errors
        if (texts.length === 0) {
            console.warn('[OpenAIEmbedding] ⚠️ embedBatch called with empty array, returning empty result');
            return [];
        }

        const processedTexts = this.preprocessTexts(texts);
        const model = this.config.model || 'text-embedding-3-small';

        // Check if using custom endpoint with batch size limit
        const isCustomEndpoint = this.config.baseURL && !this.config.baseURL.includes('api.openai.com');
        
        // Smart default: use EMBEDDING_BATCH_SIZE as reference if set
        const userBatchSize = process.env.EMBEDDING_BATCH_SIZE 
            ? parseInt(process.env.EMBEDDING_BATCH_SIZE, 10) 
            : 0;
        
        // Get max batch size with intelligent defaults
        let maxBatchSize: number;
        if (process.env.MAX_EMBEDDING_BATCH_SIZE) {
            // Explicit override
            maxBatchSize = parseInt(process.env.MAX_EMBEDDING_BATCH_SIZE, 10);
        } else if (userBatchSize > 0) {
            // Use EMBEDDING_BATCH_SIZE as reference, but respect API limits
            maxBatchSize = Math.min(userBatchSize, isCustomEndpoint ? 25 : 2048);
        } else {
            // Auto-detect based on endpoint
            maxBatchSize = isCustomEndpoint ? 25 : 2048;
        }

        // If batch is too large, split it into smaller chunks
        if (processedTexts.length > maxBatchSize) {
            console.log(`[OpenAIEmbedding] 📦 Splitting large batch (${processedTexts.length} texts) into chunks of ${maxBatchSize}`);
            
            const results: EmbeddingVector[] = [];
            for (let i = 0; i < processedTexts.length; i += maxBatchSize) {
                const chunk = texts.slice(i, i + maxBatchSize);  // Use original texts, not processed
                console.log(`[OpenAIEmbedding] 📤 Processing chunk ${Math.floor(i / maxBatchSize) + 1}/${Math.ceil(processedTexts.length / maxBatchSize)}: ${chunk.length} texts`);
                const chunkResults = await this.embedBatchInternal(chunk);
                results.push(...chunkResults);
            }
            return results;
        }

        // Process single batch (≤ maxBatchSize)
        return await this.embedBatchInternal(texts);
    }

    /**
     * Internal method to process a single batch (without splitting)
     */
    private async embedBatchInternal(texts: string[]): Promise<EmbeddingVector[]> {
        const processedTexts = this.preprocessTexts(texts);
        const model = this.config.model || 'text-embedding-3-small';

        const knownModels = OpenAIEmbedding.getSupportedModels();
        if (knownModels[model] && this.dimension !== knownModels[model].dimension) {
            this.dimension = knownModels[model].dimension;
        } else if (!knownModels[model]) {
            this.dimension = await this.detectDimension();
        }

        try {
            // Check if using custom baseURL (may not support encoding_format)
            const isCustomEndpoint = this.config.baseURL && !this.config.baseURL.includes('api.openai.com');
            
            const requestParams: any = {
                model: model,
                input: processedTexts,
            };
            
            // Only add encoding_format for official OpenAI API
            if (!isCustomEndpoint) {
                requestParams.encoding_format = 'float';
            }
            
            const response = await this.client.embeddings.create(requestParams);

            this.dimension = response.data[0].embedding.length;

            return response.data.map((item) => ({
                vector: item.embedding,
                dimension: this.dimension
            }));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(`[OpenAIEmbedding] ❌ Batch embedding failed:`);
            console.error(`   Model: ${model}`);
            console.error(`   Texts count: ${processedTexts.length}`);
            console.error(`   Sample text lengths: ${processedTexts.slice(0, 3).map(t => t.length)}`);
            throw new Error(`Failed to generate OpenAI batch embeddings: ${errorMessage}`);
        }
    }

    getDimension(): number {
        // For custom models, we need to detect the dimension first
        const model = this.config.model || 'text-embedding-3-small';
        const knownModels = OpenAIEmbedding.getSupportedModels();

        // If it's a known model, return its known dimension
        if (knownModels[model]) {
            return knownModels[model].dimension;
        }

        // For custom models, return the current dimension
        // Note: This may be incorrect until detectDimension() is called
        console.warn(`[OpenAIEmbedding] ⚠️ getDimension() called for custom model '${model}' - returning ${this.dimension}. Call detectDimension() first for accurate dimension.`);
        return this.dimension;
    }

    getProvider(): string {
        return 'OpenAI';
    }

    /**
     * Set model type
     * @param model Model name
     */
    async setModel(model: string): Promise<void> {
        this.config.model = model;
        const knownModels = OpenAIEmbedding.getSupportedModels();
        if (knownModels[model]) {
            this.dimension = knownModels[model].dimension;
        } else {
            this.dimension = await this.detectDimension();
        }
    }

    /**
     * Get client instance (for advanced usage)
     */
    getClient(): OpenAI {
        return this.client;
    }

    /**
     * Get list of supported models
     */
    static getSupportedModels(): Record<string, { dimension: number; description: string }> {
        return {
            'text-embedding-3-small': {
                dimension: 1536,
                description: 'High performance and cost-effective embedding model (recommended)'
            },
            'text-embedding-3-large': {
                dimension: 3072,
                description: 'Highest performance embedding model with larger dimensions'
            },
            'text-embedding-ada-002': {
                dimension: 1536,
                description: 'Legacy model (use text-embedding-3-small instead)'
            }
        };
    }
} 