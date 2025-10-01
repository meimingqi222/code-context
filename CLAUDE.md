# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Context is a monorepo that provides semantic code search capabilities through the Model Context Protocol (MCP). It enables AI coding assistants to search and understand entire codebases efficiently using vector embeddings and hybrid search (BM25 + dense vector).

## Architecture

This is a pnpm workspace with the following main packages:

- **`packages/core`** - Core indexing engine with embedding providers and vector database integration
- **`packages/mcp`** - MCP server for AI agent integration (published as `@zilliz/claude-context-mcp`)
- **`packages/vscode-extension`** - VSCode extension for semantic code search (published as "Semantic Code Search")
- **`packages/chrome-extension`** - Chrome extension for web-based code search
- **`examples/`** - Usage examples and demos

### Core Components

- **Embedding Providers**: OpenAI, VoyageAI, Ollama, Gemini support
- **Vector Database**: Milvus/Zilliz Cloud integration
- **Code Splitters**: AST-based and LangChain character-based splitters
- **Synchronization**: Incremental indexing using Merkle trees
- **Languages**: TypeScript, JavaScript, Python, Java, C++, C#, Go, Rust, PHP, Ruby, Swift, Kotlin, Scala, Markdown

## Development Commands

### Prerequisites
- Node.js >= 20.0.0 (NOT compatible with Node.js 24.0.0+)
- pnpm >= 10.0.0

### Common Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Development mode (all packages with file watching)
pnpm dev

# Development for specific packages
pnpm dev:core      # Core library development
pnpm dev:mcp       # MCP server development
pnpm dev:vscode    # VSCode extension development

# Build specific packages
pnpm build:core
pnpm build:mcp
pnpm build:vscode

# Linting and type checking
pnpm lint          # Lint all packages
pnpm lint:fix      # Fix linting issues
pnpm typecheck     # Type check all packages

# Clean build artifacts
pnpm clean

# Run examples
pnpm example:basic

# Performance benchmarking
pnpm benchmark

# Publishing (requires appropriate permissions)
pnpm release:core
pnpm release:mcp
pnpm release:vscode
```

### Package-Specific Commands

#### Core Package (`packages/core/`)
```bash
# Build TypeScript
pnpm build

# Watch mode for development
pnpm dev

# Run tests (if implemented)
npm test

# Lint
pnpm lint
```

#### MCP Server (`packages/mcp/`)
```bash
# Build and start MCP server
pnpm build && pnpm start

# Development with hot reload
pnpm dev

# Start with environment variables
pnpm start:with-env
```

#### VSCode Extension (`packages/vscode-extension/`)
```bash
# Compile extension
pnpm compile

# Build for production
pnpm webpack

# Development watch
pnpm watch

# Package extension
pnpm package

# Publish to marketplace
pnpm release
```

## Testing

The project uses Jest for testing. Tests are located in `packages/core/src/__tests__/` directories.

```bash
# Run tests from root
pnpm test

# Run tests for specific package
cd packages/core && npm test
```

## MCP Server Development

The MCP server is the main integration point for AI assistants. Key files:

- `packages/mcp/src/index.ts` - Main MCP server entry point
- `packages/mcp/src/handlers.ts` - MCP tool handlers (index_codebase, search_code, etc.)
- `packages/mcp/src/config.ts` - Configuration management
- `packages/mcp/src/embedding.ts` - Embedding provider setup

## Environment Variables

Common environment variables for development:

```bash
# OpenAI embeddings
OPENAI_API_KEY=sk-your-key

# VoyageAI embeddings
VOYAGE_API_KEY=your-key

# Milvus/Zilliz Cloud
MILVUS_ADDRESS=localhost:19530
MILVUS_TOKEN=your-token

# Gemini embeddings
GEMINI_API_KEY=your-key

# Ollama embeddings
OLLAMA_HOST=http://localhost:11434
```

## File Structure Notes

- TypeScript source files are in `src/` directories
- Compiled JavaScript output goes to `dist/` directories
- The workspace configuration is in `pnpm-workspace.yaml`
- Each package has its own `package.json` with specific scripts
- VSCode extension uses webpack for bundling
- MCP server is published as an ES module with CLI bin support

## Development Tips

- Use `pnpm dev` for concurrent development across packages
- Core package changes require rebuilding dependent packages
- MCP server can be tested locally: `npx @zilliz/claude-context-mcp@latest`
- VSCode extension debugging requires running in VSCode Extension Development Host
- The codebase supports both local Milvus instances and Zilliz Cloud managed service