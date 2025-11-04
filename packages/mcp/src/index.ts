#!/usr/bin/env node

// CRITICAL: Initialize logger FIRST to capture all logs
import { initLogger, getLogger } from './logger.js';

// Initialize logger with environment variables
const logger = initLogger();

// Redirect console outputs to logger to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = (...args: any[]) => {
    logger.log(...args);
};

console.warn = (...args: any[]) => {
    logger.warn(...args);
};

console.error = (...args: any[]) => {
    logger.error(...args);
};

console.debug = (...args: any[]) => {
    // Use file logging for debug info
    logger.file(...args);
};

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Context } from "@zilliz/claude-context-core";
import { MilvusVectorDatabase } from "@zilliz/claude-context-core";

// Import our modular components
import { createMcpConfig, logConfigurationSummary, showHelpMessage, ContextMcpConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";

class ContextMcpServer {
    private server: Server;
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;

    constructor(config: ContextMcpConfig) {
        // Initialize MCP server
        this.server = new Server(
            {
                name: config.name,
                version: config.version
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Initialize embedding provider
        console.log(`[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`);
        console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

        const embedding = createEmbeddingInstance(config);
        logEmbeddingProviderInfo(config, embedding);

        // Initialize vector database
        const vectorDatabase = new MilvusVectorDatabase({
            address: config.milvusAddress,
            ...(config.milvusToken && { token: config.milvusToken })
        });

        // Initialize Claude Context
        this.context = new Context({
            embedding,
            vectorDatabase
        });

        // Initialize managers
        this.snapshotManager = new SnapshotManager();
        this.syncManager = new SyncManager(this.context, this.snapshotManager);
        this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager, this.syncManager);

        // Load existing codebase snapshot on startup
        this.snapshotManager.loadCodebaseSnapshot();

        this.setupTools();
    }

    private setupTools() {
        const index_description = `
🔍 **Index a codebase for semantic search**

Enables AI-powered code understanding across the entire project. This tool creates a searchable knowledge base of your code.

✨ **Why index**:
- Find code by describing what it does in natural language
- Discover related functions/classes across the entire codebase
- Understand code architecture and patterns instantly
- Much faster and more accurate than grep for complex queries

🎯 **When to use**:
- First time working with a codebase → Index immediately
- Before any code exploration or analysis task
- When grep/file search isn't finding what you need
- Before implementing new features or fixing bugs

⚡ **Process**:
- Indexes in background (1-5 minutes for most projects)
- You can start searching immediately
- Automatically filters out node_modules, build artifacts, etc.

Just provide the absolute project path to start!
`;


        const search_description = `
🔍 **Semantic code search - Find code by describing what it does**

Search your indexed codebase using natural language. Much more powerful than grep/file search.

🎯 **Use this for**:
- "Find authentication logic" → Locates all auth-related code
- "Database connection setup" → Finds DB initialization
- "Error handling for API calls" → Discovers error patterns
- "Functions that parse JSON" → Identifies JSON utilities
- "Classes implementing caching" → Finds cache implementations

✨ **Advantages over grep**:
- Understands code meaning, not just text matching
- Finds related code even with different variable names
- Returns ranked results (most relevant first)
- Includes code context (file path, line numbers, snippets)

💡 **Best practices**:
- Use descriptive queries ("functions that validate email" not just "email")
- Ask about functionality, not specific variable names
- For new codebases → Always index first, then search

📋 **Output**: Returns top relevant code chunks with file locations.
`;

        // Define available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "index_codebase",
                        description: index_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to index.`
                                },
                                force: {
                                    type: "boolean",
                                    description: "Force re-indexing even if already indexed",
                                    default: false
                                },
                                splitter: {
                                    type: "string",
                                    description: "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
                                    enum: ["ast", "langchain"],
                                    default: "ast"
                                },
                                customExtensions: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                                    default: []
                                },
                                ignorePatterns: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                                    default: []
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to search in.`
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for in the codebase"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                }
                            },
                            required: ["path", "query"]
                        }
                    },
                    {
                        name: "clear_index",
                        description: `Clear the search index. IMPORTANT: You MUST provide an absolute path.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to clear.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "get_indexing_status",
                        description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to check status for.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "text_grep",
                        description: `High-performance cross-platform text search tool (grep alternative).

🔍 **Key Features**:
- ⚡ Concurrent file searching for 3-10x faster performance
- 🌐 Cross-platform: Works on Windows, Linux, and macOS
- 🎯 Smart filtering: Automatically respects .gitignore, .warpindexingignore, .claudeignore
- 🚫 Auto-excludes: node_modules, dist, build, .git, and other common directories
- 📝 Context lines: Shows surrounding code for better understanding
- 🔢 Regex support: Use regular expressions for complex patterns
- 📁 File filtering: Search only specific file types

🎯 **When to Use**:
- Finding specific variable names, function calls, or identifiers
- Searching for error messages or log strings
- Finding TODO/FIXME comments
- Locating configuration values or constants
- Pattern matching across multiple files

💡 **Comparison**:
- Use \`text_grep\` for literal string/pattern matching
- Use \`search_code\` for semantic/meaning-based search

⚠️ **IMPORTANT**: You MUST provide an absolute path.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "ABSOLUTE path to the directory to search in"
                                },
                                pattern: {
                                    type: "string",
                                    description: "Text pattern to search for. Can be literal text or regex if isRegex=true"
                                },
                                caseSensitive: {
                                    type: "boolean",
                                    description: "Whether the search should be case-sensitive",
                                    default: false
                                },
                                isRegex: {
                                    type: "boolean",
                                    description: "Whether the pattern is a regular expression",
                                    default: false
                                },
                                filePattern: {
                                    type: "string",
                                    description: "Optional: Glob pattern to filter files (e.g., '*.ts', '*.{js,jsx}', 'test*.py')"
                                },
                                maxResults: {
                                    type: "number",
                                    description: "Maximum number of matches to return",
                                    default: 100,
                                    maximum: 1000
                                },
                                contextLines: {
                                    type: "number",
                                    description: "Number of context lines to show before and after each match",
                                    default: 2,
                                    maximum: 10
                                },
                                respectGitignore: {
                                    type: "boolean",
                                    description: "Whether to respect .gitignore and other ignore files",
                                    default: true
                                },
                                timeout: {
                                    type: "number",
                                    description: "Search timeout in milliseconds (default: 10000)",
                                    default: 10000,
                                    minimum: 1000,
                                    maximum: 60000
                                }
                            },
                            required: ["path", "pattern"]
                        }
                    },
                ]
            };
        });

        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            switch (name) {
                case "index_codebase":
                    return await this.toolHandlers.handleIndexCodebase(args);
                case "search_code":
                    return await this.toolHandlers.handleSearchCode(args);
                case "clear_index":
                    return await this.toolHandlers.handleClearIndex(args);
                case "get_indexing_status":
                    return await this.toolHandlers.handleGetIndexingStatus(args);
                case "text_grep":
                    return await this.toolHandlers.handleTextSearch(args);

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('[SYNC-DEBUG] MCP server start() method called');
        console.log('Starting Context MCP server...');
        
        // Log file location info
        const logger = getLogger();
        console.log(`📁 Log directory: ${logger.getLogDir()}`);
        console.log(`📝 Current log file: ${logger.getCurrentLogFile()}`);

        const transport = new StdioServerTransport();
        console.log('[SYNC-DEBUG] StdioServerTransport created, attempting server connection...');

        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
        console.log('[SYNC-DEBUG] Server connection established successfully');

        // Start background sync after server is connected
        console.log('[SYNC-DEBUG] Initializing background sync...');
        this.syncManager.startBackgroundSync();
        console.log('[SYNC-DEBUG] MCP server initialization complete');
    }
}

// Main execution
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Show help if requested
    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    // Create configuration
    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    await server.start();
    
    // Keep the process running - MCP server needs to stay alive
    // The server will handle stdio communication and should not exit
    // Return a promise that never resolves to keep the process alive
    console.log('[SYNC-DEBUG] MCP server is now running and waiting for requests...');
    return new Promise(() => {}); // Never resolves, keeps process alive
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.error("Received SIGINT, shutting down gracefully...");
    getLogger().close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    getLogger().close();
    process.exit(0);
});

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
    console.error("Fatal error:", error);
    console.error("Fatal error type:", typeof error);
    console.error("Fatal error stack:", error?.stack);
    console.error("Fatal error message:", error?.message);
    getLogger().close();
    process.exit(1);
});
