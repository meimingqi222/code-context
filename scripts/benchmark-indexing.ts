#!/usr/bin/env ts-node
/**
 * Indexing Performance Benchmark
 * 
 * This script tests the actual performance improvement of concurrent indexing
 * by comparing serial vs concurrent modes on a real codebase.
 */

import { Context } from '../packages/core/src/context';
import { MilvusVectorDatabase } from '../packages/core/src/vectordb/milvus-vectordb';
import { OpenAIEmbedding } from '../packages/core/src/embedding/openai-embedding';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface BenchmarkResult {
    mode: string;
    totalTime: number;
    filesProcessed: number;
    chunksIndexed: number;
    filesPerSecond: number;
    chunksPerSecond: number;
    avgTimePerFile: number;
    memoryUsed: number;
    cpuCores: number;
}

async function runBenchmark(
    codebasePath: string,
    mode: 'serial' | 'concurrent',
    embedding: any,
    vectorDb: any
): Promise<BenchmarkResult> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running benchmark in ${mode.toUpperCase()} mode`);
    console.log(`${'='.repeat(60)}\n`);

    // Configure environment for the mode
    if (mode === 'serial') {
        process.env.ENABLE_CONCURRENT_INDEXING = 'false';
    } else {
        process.env.ENABLE_CONCURRENT_INDEXING = 'true';
        process.env.FILE_CONCURRENCY = String(Math.min(os.cpus().length * 2, 20));
    }

    const context = new Context({
        embedding,
        vectorDatabase: vectorDb
    });

    const startTime = Date.now();
    const startMemory = process.memoryUsage().heapUsed;

    let filesProcessed = 0;
    let chunksIndexed = 0;

    try {
        const result = await context.indexCodebase(codebasePath, (progress) => {
            // Track progress
            if (progress.phase.includes('Processing files')) {
                filesProcessed = progress.current;
                chunksIndexed = progress.total || 0;
            }
        });

        filesProcessed = result.indexedFiles;
        chunksIndexed = result.totalChunks;
    } catch (error) {
        console.error(`Benchmark failed in ${mode} mode:`, error);
        throw error;
    }

    const endTime = Date.now();
    const endMemory = process.memoryUsage().heapUsed;

    const totalTime = endTime - startTime;
    const memoryUsed = Math.round((endMemory - startMemory) / 1024 / 1024);
    const filesPerSecond = (filesProcessed / totalTime) * 1000;
    const chunksPerSecond = (chunksIndexed / totalTime) * 1000;
    const avgTimePerFile = totalTime / filesProcessed;

    return {
        mode,
        totalTime,
        filesProcessed,
        chunksIndexed,
        filesPerSecond,
        chunksPerSecond,
        avgTimePerFile,
        memoryUsed,
        cpuCores: os.cpus().length
    };
}

function printResult(result: BenchmarkResult) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${result.mode.toUpperCase()} Mode Results`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Total Time:        ${(result.totalTime / 1000).toFixed(2)}s`);
    console.log(`Files Processed:   ${result.filesProcessed}`);
    console.log(`Chunks Indexed:    ${result.chunksIndexed}`);
    console.log(`Files/sec:         ${result.filesPerSecond.toFixed(2)}`);
    console.log(`Chunks/sec:        ${result.chunksPerSecond.toFixed(2)}`);
    console.log(`Avg Time/File:     ${result.avgTimePerFile.toFixed(0)}ms`);
    console.log(`Memory Used:       ${result.memoryUsed}MB`);
    console.log(`CPU Cores:         ${result.cpuCores}`);
    console.log(`${'='.repeat(60)}\n`);
}

function compareResults(serial: BenchmarkResult, concurrent: BenchmarkResult) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PERFORMANCE COMPARISON`);
    console.log(`${'='.repeat(60)}`);
    
    const speedup = serial.totalTime / concurrent.totalTime;
    const filesSpeedup = concurrent.filesPerSecond / serial.filesPerSecond;
    const chunksSpeedup = concurrent.chunksPerSecond / serial.chunksPerSecond;
    
    console.log(`\nTime Improvement:`);
    console.log(`  Serial:     ${(serial.totalTime / 1000).toFixed(2)}s`);
    console.log(`  Concurrent: ${(concurrent.totalTime / 1000).toFixed(2)}s`);
    console.log(`  Speedup:    ${speedup.toFixed(2)}x ${speedup > 1 ? '✅' : '❌'}`);
    
    console.log(`\nThroughput Improvement:`);
    console.log(`  Files/sec speedup:  ${filesSpeedup.toFixed(2)}x`);
    console.log(`  Chunks/sec speedup: ${chunksSpeedup.toFixed(2)}x`);
    
    console.log(`\nMemory Overhead:`);
    console.log(`  Serial:     ${serial.memoryUsed}MB`);
    console.log(`  Concurrent: ${concurrent.memoryUsed}MB`);
    console.log(`  Overhead:   ${((concurrent.memoryUsed - serial.memoryUsed) / serial.memoryUsed * 100).toFixed(1)}%`);
    
    console.log(`\n${'='.repeat(60)}`);
    
    // Realistic assessment
    console.log(`\nREALISTIC ASSESSMENT:`);
    if (speedup > 3) {
        console.log(`⚠️  WARNING: ${speedup.toFixed(2)}x speedup seems unrealistic.`);
        console.log(`   Actual bottlenecks may be:`);
        console.log(`   - Network latency (embedding API calls)`);
        console.log(`   - Database write speed`);
        console.log(`   - Embedding generation time`);
    } else if (speedup > 1.5) {
        console.log(`✅ Significant improvement: ${speedup.toFixed(2)}x speedup`);
        console.log(`   File I/O parallelization is working effectively`);
    } else if (speedup > 1.1) {
        console.log(`✅ Moderate improvement: ${speedup.toFixed(2)}x speedup`);
        console.log(`   Some benefit from concurrent processing`);
    } else {
        console.log(`❌ No significant improvement: ${speedup.toFixed(2)}x`);
        console.log(`   Bottleneck is likely not file I/O`);
    }
    
    console.log(`${'='.repeat(60)}\n`);
}

async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: ts-node benchmark-indexing.ts <codebase-path>');
        console.log('\nExample:');
        console.log('  ts-node scripts/benchmark-indexing.ts /path/to/test/project');
        console.log('\nNote: Requires environment variables:');
        console.log('  - OPENAI_API_KEY (for embeddings)');
        console.log('  - MILVUS_ADDRESS (for vector storage)');
        process.exit(1);
    }

    const codebasePath = path.resolve(args[0]);
    
    if (!fs.existsSync(codebasePath)) {
        console.error(`Error: Path does not exist: ${codebasePath}`);
        process.exit(1);
    }

    console.log('Indexing Performance Benchmark');
    console.log('================================\n');
    console.log(`Codebase:  ${codebasePath}`);
    console.log(`CPU Cores: ${os.cpus().length}`);
    console.log(`Memory:    ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB\n`);

    // Check required environment variables
    if (!process.env.OPENAI_API_KEY) {
        console.error('Error: OPENAI_API_KEY environment variable not set');
        process.exit(1);
    }
    if (!process.env.MILVUS_ADDRESS) {
        console.error('Error: MILVUS_ADDRESS environment variable not set');
        process.exit(1);
    }

    // Initialize services (shared across tests)
    const embedding = new OpenAIEmbedding({
        apiKey: process.env.OPENAI_API_KEY!,
        model: 'text-embedding-3-small'
    });

    const vectorDb = new MilvusVectorDatabase({
        address: process.env.MILVUS_ADDRESS!,
        token: process.env.MILVUS_TOKEN
    });

    try {
        // Test 1: Serial mode
        console.log('\n🐌 Testing SERIAL mode (baseline)...\n');
        const serialResult = await runBenchmark(codebasePath, 'serial', embedding, vectorDb);
        printResult(serialResult);

        // Clean up for next test
        const context = new Context({ embedding, vectorDatabase: vectorDb });
        await context.clearIndex(codebasePath);
        console.log('✅ Cleaned up index\n');

        // Wait a bit to avoid rate limiting
        console.log('Waiting 5 seconds before concurrent test...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Test 2: Concurrent mode
        console.log('\n🚀 Testing CONCURRENT mode...\n');
        const concurrentResult = await runBenchmark(codebasePath, 'concurrent', embedding, vectorDb);
        printResult(concurrentResult);

        // Compare results
        compareResults(serialResult, concurrentResult);

        // Save results to file
        const results = {
            timestamp: new Date().toISOString(),
            codebase: codebasePath,
            system: {
                cpuCores: os.cpus().length,
                totalMemoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
                platform: os.platform()
            },
            serial: serialResult,
            concurrent: concurrentResult,
            speedup: serialResult.totalTime / concurrentResult.totalTime
        };

        const resultsPath = path.join(__dirname, '../benchmark-results.json');
        fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📊 Results saved to: ${resultsPath}\n`);

    } catch (error) {
        console.error('\n❌ Benchmark failed:', error);
        process.exit(1);
    }
}

main();
