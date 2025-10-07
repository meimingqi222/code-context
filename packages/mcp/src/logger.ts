import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface LoggerConfig {
    logDir?: string;
    maxLogFiles?: number;
    maxLogSizeMB?: number;
    enableFileLogging?: boolean;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Unified logger for MCP server
 * - Writes logs to both stderr (for MCP protocol) and log files
 * - Automatically rotates logs when they exceed size limit
 * - Automatically cleans up old log files
 */
export class Logger {
    private logDir: string;
    private maxLogFiles: number;
    private maxLogSizeMB: number;
    private enableFileLogging: boolean;
    private logLevel: string;
    private currentLogFile: string;
    private logStream: fs.WriteStream | null = null;
    private currentLogSize: number = 0;

    constructor(config: LoggerConfig = {}) {
        // Default log directory: ~/.context/logs
        this.logDir = config.logDir || path.join(os.homedir(), '.context', 'logs');
        this.maxLogFiles = config.maxLogFiles || 7; // Keep last 7 log files
        this.maxLogSizeMB = config.maxLogSizeMB || 10; // 10MB per log file
        this.enableFileLogging = config.enableFileLogging !== false; // Enabled by default
        this.logLevel = config.logLevel || 'info';
        
        // Initialize log directory and file
        this.currentLogFile = this.getLogFileName();
        this.initializeLogDirectory();
        this.cleanOldLogs();
        
        if (this.enableFileLogging) {
            this.openLogStream();
        }
    }

    /**
     * Initialize log directory
     */
    private initializeLogDirectory(): void {
        try {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
        } catch (error) {
            process.stderr.write(`[LOGGER] Failed to create log directory: ${error}\n`);
        }
    }

    /**
     * Generate log file name with timestamp
     */
    private getLogFileName(): string {
        const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
        return path.join(this.logDir, `mcp-${timestamp}.log`);
    }

    /**
     * Open log stream for writing
     */
    private openLogStream(): void {
        try {
            // Check if current log file exists and its size
            if (fs.existsSync(this.currentLogFile)) {
                const stats = fs.statSync(this.currentLogFile);
                this.currentLogSize = stats.size;
                
                // If file is too large, rotate immediately
                if (this.currentLogSize >= this.maxLogSizeMB * 1024 * 1024) {
                    this.rotateLog();
                    return;
                }
            }

            this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
            this.logStream.on('error', (error) => {
                process.stderr.write(`[LOGGER] Log stream error: ${error}\n`);
            });
        } catch (error) {
            process.stderr.write(`[LOGGER] Failed to open log stream: ${error}\n`);
        }
    }

    /**
     * Rotate log file when size limit is reached
     */
    private rotateLog(): void {
        try {
            // Close current stream
            if (this.logStream) {
                this.logStream.end();
                this.logStream = null;
            }

            // Create new log file
            this.currentLogFile = this.getLogFileName();
            this.currentLogSize = 0;
            this.openLogStream();

            // Clean old logs after rotation
            this.cleanOldLogs();
        } catch (error) {
            process.stderr.write(`[LOGGER] Failed to rotate log: ${error}\n`);
        }
    }

    /**
     * Clean old log files, keep only maxLogFiles newest files
     */
    private cleanOldLogs(): void {
        try {
            if (!fs.existsSync(this.logDir)) {
                return;
            }

            const files = fs.readdirSync(this.logDir)
                .filter(file => file.startsWith('mcp-') && file.endsWith('.log'))
                .map(file => ({
                    name: file,
                    path: path.join(this.logDir, file),
                    time: fs.statSync(path.join(this.logDir, file)).mtime.getTime()
                }))
                .sort((a, b) => b.time - a.time); // Sort by time, newest first

            // Remove old files
            const filesToRemove = files.slice(this.maxLogFiles);
            for (const file of filesToRemove) {
                try {
                    fs.unlinkSync(file.path);
                    process.stderr.write(`[LOGGER] 🗑️  Cleaned old log file: ${file.name}\n`);
                } catch (error) {
                    process.stderr.write(`[LOGGER] Failed to remove log file ${file.name}: ${error}\n`);
                }
            }

            if (files.length > 0) {
                process.stderr.write(`[LOGGER] 📁 Log directory: ${this.logDir} (${files.length} files, max ${this.maxLogFiles})\n`);
            }
        } catch (error) {
            process.stderr.write(`[LOGGER] Failed to clean old logs: ${error}\n`);
        }
    }

    /**
     * Write log message to both stderr and file
     */
    private writeLog(level: string, prefix: string, message: string): void {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${prefix} ${message}\n`;

        // Always write to stderr for MCP protocol
        process.stderr.write(logMessage);

        // Write to file if enabled
        if (this.enableFileLogging && this.logStream) {
            try {
                this.logStream.write(logMessage);
                this.currentLogSize += Buffer.byteLength(logMessage);

                // Check if rotation is needed
                if (this.currentLogSize >= this.maxLogSizeMB * 1024 * 1024) {
                    this.rotateLog();
                }
            } catch (error) {
                process.stderr.write(`[LOGGER] Failed to write to log file: ${error}\n`);
            }
        }
    }

    /**
     * Safely stringify an object, handling circular references
     */
    private safeStringify(obj: any): string {
        try {
            if (obj === null || obj === undefined) {
                return String(obj);
            }
            if (typeof obj !== 'object') {
                return String(obj);
            }
            if (obj instanceof Error) {
                return `${obj.name}: ${obj.message}${obj.stack ? '\n' + obj.stack : ''}`;
            }
            // Use JSON.stringify with circular reference handler
            return JSON.stringify(obj, (key, value) => {
                // Handle circular references
                if (typeof value === 'object' && value !== null) {
                    // Simple check - return string representation for complex objects
                    if (value.constructor && value.constructor.name && 
                        value.constructor.name !== 'Object' && value.constructor.name !== 'Array') {
                        return `[${value.constructor.name}]`;
                    }
                }
                return value;
            });
        } catch (error) {
            // If all else fails, return a simple string representation
            return `[Object ${obj.constructor?.name || 'Unknown'}]`;
        }
    }

    /**
     * Log info message
     */
    log(...args: any[]): void {
        const message = args.map(arg => 
            typeof arg === 'object' ? this.safeStringify(arg) : String(arg)
        ).join(' ');
        this.writeLog('info', '[LOG]', message);
    }

    /**
     * Log warning message
     */
    warn(...args: any[]): void {
        const message = args.map(arg => 
            typeof arg === 'object' ? this.safeStringify(arg) : String(arg)
        ).join(' ');
        this.writeLog('warn', '[WARN]', message);
    }

    /**
     * Log error message
     */
    error(...args: any[]): void {
        const message = args.map(arg => 
            typeof arg === 'object' ? this.safeStringify(arg) : String(arg)
        ).join(' ');
        this.writeLog('error', '[ERROR]', message);
    }

    /**
     * Log debug message (only if log level is debug)
     */
    debug(...args: any[]): void {
        if (this.logLevel === 'debug') {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            ).join(' ');
            this.writeLog('debug', '[DEBUG]', message);
        }
    }

    /**
     * Close log stream
     */
    close(): void {
        if (this.logStream) {
            this.logStream.end();
            this.logStream = null;
        }
    }

    /**
     * Get log directory path
     */
    getLogDir(): string {
        return this.logDir;
    }

    /**
     * Get current log file path
     */
    getCurrentLogFile(): string {
        return this.currentLogFile;
    }
}

// Singleton logger instance
let globalLogger: Logger | null = null;

/**
 * Initialize global logger
 */
export function initLogger(config?: LoggerConfig): Logger {
    if (globalLogger) {
        globalLogger.close();
    }
    
    // Read config from environment variables
    const envConfig: LoggerConfig = {
        logDir: process.env.LOG_DIR,
        maxLogFiles: process.env.MAX_LOG_FILES ? parseInt(process.env.MAX_LOG_FILES, 10) : undefined,
        maxLogSizeMB: process.env.MAX_LOG_SIZE_MB ? parseInt(process.env.MAX_LOG_SIZE_MB, 10) : undefined,
        enableFileLogging: process.env.ENABLE_FILE_LOGGING !== 'false',
        logLevel: (process.env.LOG_LEVEL as any) || 'info'
    };
    
    // Merge with provided config
    const finalConfig = { ...envConfig, ...config };
    
    globalLogger = new Logger(finalConfig);
    return globalLogger;
}

/**
 * Get global logger instance
 */
export function getLogger(): Logger {
    if (!globalLogger) {
        globalLogger = initLogger();
    }
    return globalLogger;
}
