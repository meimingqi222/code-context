# Environment Variables Configuration

## 🎯 Global Configuration

Claude Context supports a global configuration file at `~/.context/.env` to simplify MCP setup across different MCP clients.

**Benefits:**
- Configure once, use everywhere
- No need to specify environment variables in each MCP client
- Cleaner MCP configurations

## 📋 Environment Variable Priority

1. **Process Environment Variables** (highest)
2. **Global Configuration File** (`~/.context/.env`)
3. **Default Values** (lowest)

## 🔧 Required Environment Variables

### Embedding Provider
| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_PROVIDER` | Provider: `OpenAI`, `VoyageAI`, `Gemini`, `Ollama` | `OpenAI` |
| `EMBEDDING_MODEL` | Embedding model name (works for all providers) | Provider-specific default |
| `OPENAI_API_KEY` | OpenAI API key | Required for OpenAI |
| `OPENAI_BASE_URL` | OpenAI API base URL (optional, for custom endpoints) | `https://api.openai.com/v1` |
| `VOYAGEAI_API_KEY` | VoyageAI API key | Required for VoyageAI |
| `GEMINI_API_KEY` | Gemini API key | Required for Gemini |
| `GEMINI_BASE_URL` | Gemini API base URL (optional, for custom endpoints) | `https://generativelanguage.googleapis.com/v1beta` |

> **💡 Note:** `EMBEDDING_MODEL` is a universal environment variable that works with all embedding providers. Simply set it to the model name you want to use (e.g., `text-embedding-3-large` for OpenAI, `voyage-code-3` for VoyageAI, etc.).

> **Supported Model Names:**
> 
> - OpenAI Models: See `getSupportedModels` in [`openai-embedding.ts`](https://github.com/zilliztech/claude-context/blob/master/packages/core/src/embedding/openai-embedding.ts) for the full list of supported models.
> 
> - VoyageAI Models: See `getSupportedModels` in [`voyageai-embedding.ts`](https://github.com/zilliztech/claude-context/blob/master/packages/core/src/embedding/voyageai-embedding.ts) for the full list of supported models.
> 
> - Gemini Models: See `getSupportedModels` in [`gemini-embedding.ts`](https://github.com/zilliztech/claude-context/blob/master/packages/core/src/embedding/gemini-embedding.ts) for the full list of supported models.
> 
> - Ollama Models: Depends on the model you install locally.

> **📖 For detailed provider-specific configuration examples and setup instructions, see the [MCP Configuration Guide](../../packages/mcp/README.md#embedding-provider-configuration).**

### Vector Database
| Variable | Description | Default |
|----------|-------------|---------|
| `MILVUS_TOKEN` | Milvus authentication token. Get [Zilliz Personal API Key](https://github.com/zilliztech/claude-context/blob/master/assets/signup_and_get_apikey.png) | Recommended |
| `MILVUS_ADDRESS` | Milvus server address. Optional when using Zilliz Personal API Key | Auto-resolved from token |

### Ollama (Optional)
| Variable | Description | Default |
|----------|-------------|---------|
| `OLLAMA_HOST` | Ollama server URL | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL`(alternative to `EMBEDDING_MODEL`) | Model name |  |

### Logging Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` | `warn` |
| `LOG_DIR` | Directory for log files | `~/.context/logs` |
| `MAX_LOG_FILES` | Maximum number of log files to keep | `7` |
| `MAX_LOG_SIZE_MB` | Maximum size per log file in MB | `10` |
| `ENABLE_FILE_LOGGING` | Enable file logging. Set to `false` to disable | `true` |

> **💡 Logging Tips:**
> - **Default Level**: Set to `warn` to log warnings and errors while filtering out verbose info logs (~77% reduction)
> - **Minimal Logging**: Set `LOG_LEVEL=error` to only log errors (maximum reduction)
> - **Debug Mode**: Set `LOG_LEVEL=debug` for detailed debugging information (all logs)
> - **Info Mode**: Set `LOG_LEVEL=info` for general operational logs (includes all non-debug logs)
> - **Disable Logging**: Set `ENABLE_FILE_LOGGING=false` to completely disable file logging

### Advanced Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `HYBRID_MODE` | Enable hybrid search (BM25 + dense vector). Set to `false` for dense-only search | `true` |
| `EMBEDDING_BATCH_SIZE` | Batch size for processing. Larger batch size means less indexing time | Provider-specific (100-1000) |
| `SPLITTER_TYPE` | Code splitter type: `ast`, `langchain` | `ast` |
| `CUSTOM_EXTENSIONS` | Additional file extensions to include (comma-separated, e.g., `.vue,.svelte,.astro`) | None |
| `CUSTOM_IGNORE_PATTERNS` | Additional ignore patterns (comma-separated, e.g., `temp/**,*.backup,private/**`) | None |

### Performance Optimization (Advanced)
| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_CONCURRENT_INDEXING` | Enable concurrent file processing and embedding generation | `true` |
| `FILE_CONCURRENCY` | Number of files to process concurrently | CPU cores × 2 (max 20) |
| `API_CONCURRENCY` | Number of concurrent API calls to embedding provider | Provider-specific (2-10) |
| `MEMORY_LIMIT_MB` | Memory limit in MB for adaptive memory management | `1536` |
| `ENABLE_PERFORMANCE_MONITORING` | Enable detailed performance monitoring and reporting | `false` |

> **💡 Performance Tips:**
> - **Concurrent Indexing**: Enabled by default for faster indexing. Set to `false` for legacy serial mode.
> - **FILE_CONCURRENCY**: Higher values speed up file reading but increase memory usage. Adjust based on system resources.
> - **API_CONCURRENCY**: Automatically tuned per provider. OpenAI=5, VoyageAI=3, Gemini=2, Ollama=10.
> - **MEMORY_LIMIT_MB**: Triggers adaptive batch sizing when memory pressure is high. Increase for systems with more RAM.
> - **Performance Monitoring**: Enable to see detailed metrics including pipeline overlap, throughput, and memory usage.

## 🚀 Quick Setup

### 1. Create Global Config
```bash
mkdir -p ~/.context
cat > ~/.context/.env << 'EOF'
EMBEDDING_PROVIDER=OpenAI
OPENAI_API_KEY=sk-your-openai-api-key
EMBEDDING_MODEL=text-embedding-3-small
MILVUS_TOKEN=your-zilliz-cloud-api-key
EOF
```

See the [Example File](../../.env.example) for more details.

### 2. Simplified MCP Configuration

**Claude Code:**
```bash
claude mcp add claude-context -- npx @zilliz/claude-context-mcp@latest
```

**Cursor/Windsurf/Others:**
```json
{
  "mcpServers": {
    "claude-context": {
      "command": "npx",
      "args": ["-y", "@zilliz/claude-context-mcp@latest"]
    }
  }
}
```

## 📚 Additional Information

For detailed information about file processing rules and how custom patterns work, see:
- [What files does Claude Context decide to embed?](../troubleshooting/faq.md#q-what-files-does-claude-context-decide-to-embed)
 