#!/usr/bin/env node

// Simple test to verify the subdirectory fix logic
import * as path from 'path';

/**
 * Check if a directory is indexed or is a subdirectory of an indexed directory
 */
function isPathIndexedOrNested(searchPath, indexedPaths) {
    const normalizedSearchPath = path.resolve(searchPath);

    // Check if the search path is exactly in the indexed paths
    if (indexedPaths.includes(normalizedSearchPath)) {
        return true;
    }

    // Check if the search path is a subdirectory of any indexed path
    for (const indexedPath of indexedPaths) {
        const normalizedIndexPath = path.resolve(indexedPath);

        // Check if searchPath starts with indexedPath + path separator
        if (normalizedSearchPath.startsWith(normalizedIndexPath + path.sep)) {
            return true;
        }

        // Also handle the case where paths are exactly equal (for root directory)
        if (normalizedSearchPath === normalizedIndexPath) {
            return true;
        }
    }

    return false;
}

// Test cases
console.log('Testing subdirectory fix logic...\n');

const indexedPaths = [
    '/Users/yuqiang/work/code/Warp2Api'
];

const testCases = [
    {
        path: '/Users/yuqiang/work/code/Warp2Api',
        description: 'Exact indexed directory'
    },
    {
        path: '/Users/yuqiang/work/code/Warp2Api/warp-proxy',
        description: 'Subdirectory of indexed directory'
    },
    {
        path: '/Users/yuqiang/work/code/Warp2Api/warp-proxy/src',
        description: 'Nested subdirectory'
    },
    {
        path: '/Users/yuqiang/work/code/OtherProject',
        description: 'Completely different directory'
    }
];

testCases.forEach(testCase => {
    const isIndexed = isPathIndexedOrNested(testCase.path, indexedPaths);
    console.log(`${testCase.description}:`);
    console.log(`  Path: ${testCase.path}`);
    console.log(`  Is Indexed: ${isIndexed ? '✅ YES' : '❌ NO'}\n`);
});

console.log('Test completed!');