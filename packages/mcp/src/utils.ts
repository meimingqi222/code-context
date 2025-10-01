import * as path from "path";

/**
 * Truncate content to specified length
 */
export function truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
        return content;
    }
    return content.substring(0, maxLength) + '...';
}

/**
 * Ensure path is absolute. If relative path is provided, resolve it properly.
 */
export function ensureAbsolutePath(inputPath: string): string {
    // If already absolute, return as is
    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }

    // For relative paths, resolve to absolute path
    const resolved = path.resolve(inputPath);
    return resolved;
}

/**
 * Check if a directory is indexed or is a subdirectory of an indexed directory
 */
export function isPathIndexedOrNested(searchPath: string, indexedPaths: string[]): boolean {
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

export function trackCodebasePath(codebasePath: string): void {
    const absolutePath = ensureAbsolutePath(codebasePath);
    console.log(`[TRACKING] Tracked codebase path: ${absolutePath} (not marked as indexed)`);
} 