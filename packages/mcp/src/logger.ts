import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
    logDir?: string;
    maxLogFiles?: number;
    maxLogSizeMB?: number;
    enableFileLogging?: boolean;
    logLevel?: LogLevel;
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
    private logLevel: LogLevel;
    private currentLogFile: string;
    private logStream: fs.WriteStream | null = null;
    private currentLogSize: number = 0;
    
    // Log level priority mapping
    private readonly logLevelPriority: Record<LogLevel, number> = {
        'debug': 0,
        'info': 1,
        'warn': 2,
        'error': 3
    };

    constructor(config: LoggerConfig = {}) {
        // Default log directory: ~/.context/logs
        this.logDir = config.logDir || path.join(os.homedir(), '.context', 'logs');
        this.maxLogFiles = config.maxLogFiles || 7; // Keep last 7 log files
        this.maxLogSizeMB = config.maxLogSizeMB || 10; // 10MB per log file
        this.enableFileLogging = config.enableFileLogging !== false; // Enabled by default
        this.logLevel = config.logLevel || 'error'; // Default to error level only to reduce log volume
        
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
     * Generate log file name with date and process ID
     * Creates one log file per day per process to avoid file spam
     */
    private getLogFileName(): string {
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
        const pid = process.pid;
        return path.join(this.logDir, `mcp-${date}-pid-${pid}.log`);
    }

    /**
     * Open log stream for writing (legacy method, now using appendFileSync)
     * Kept for compatibility with other logging methods
     */
    private openLogStream(): void {
        try {
            // Update current log file size
            this.updateCurrentLogSize();
            
            // If file is too large, rotate immediately
            if (this.currentLogSize >= this.maxLogSizeMB * 1024 * 1024) {
                this.rotateLog();
                return;
            }

            // Note: This stream is no longer used for file() method
            // Kept for potential future use with console.log() methods
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
     * For rotation, we add a timestamp to create unique files
     */
    private rotateLog(): void {
        try {
            // Close current stream
            if (this.logStream) {
                this.logStream.end();
                this.logStream = null;
            }

            // Create new log file with timestamp for rotation
            const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
            const time = new Date().toISOString().split('T')[1].split('.')[0].replace(/:/g, '-'); // HH-MM-SS format
            const pid = process.pid;
            this.currentLogFile = path.join(this.logDir, `mcp-${date}-pid-${pid}-rotated-${time}.log`);
            this.currentLogSize = 0;

            this.cleanOldLogs();
        } catch (error) {
            process.stderr.write(`[LOGGER] Failed to rotate log: ${error}\n`);
        }
    }

    /**
     * Clean old log files, keep only maxLogFiles newest files
     * Supports new file naming pattern with process IDs
     */
    private cleanOldLogs(): void {
        try {
            if (!fs.existsSync(this.logDir)) {
                return;
            }

            const files = fs.readdirSync(this.logDir)
                .filter(file => file.startsWith('mcp-') && (file.endsWith('.log') || file.includes('.log')))
                .map(file => {
                    const filePath = path.join(this.logDir, file);
                    return {
                        name: file,
                        path: filePath,
                        time: fs.statSync(filePath).mtime.getTime()
                    };
                })
                .sort((a, b) => b.time - a.time); // Sort by time, newest first

            // Remove old files
            const filesToRemove = files.slice(this.maxLogFiles);
            let cleanedCount = 0;
            for (const file of filesToRemove) {
                try {
                    fs.unlinkSync(file.path);
                    cleanedCount++;
                } catch (error) {
                    process.stderr.write(`[LOGGER] Failed to remove log file ${file.name}: ${error}\n`);
                }
            }

            if (cleanedCount > 0) {
                process.stderr.write(`[LOGGER] 🗑️  Cleaned ${cleanedCount} old log files\n`);
            }

            if (files.length > 0) {
                process.stderr.write(`[LOGGER] 📁 Log directory: ${this.logDir} (${files.length} files, max ${this.maxLogFiles})\n`);
            }
        } catch (error) {
            process.stderr.write(`[LOGGER] Failed to clean old logs: ${error}\n`);
        }
    }

    /**
     * Update current log file size by reading actual file size
     * This is more accurate for tracking when to rotate logs
     */
    private updateCurrentLogSize(): void {
        try {
            if (fs.existsSync(this.currentLogFile)) {
                const stats = fs.statSync(this.currentLogFile);
                this.currentLogSize = stats.size;
            }
        } catch (error) {
            process.stderr.write(`[LOGGER] Failed to get current log file size: ${error}\n`);
        }
    }

    /**
     * Check if a log level should be logged based on current log level setting
     */
    private shouldLog(level: LogLevel): boolean {
        return this.logLevelPriority[level] >= this.logLevelPriority[this.logLevel];
    }

    /**
     * Write log message to both stderr and file
     */
    private writeLog(level: LogLevel, prefix: string, message: string): void {
        // Filter logs based on log level
        if (!this.shouldLog(level)) {
            return;
        }

        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${prefix} ${message}\n`;

        // MCP协议：只输出错误级别到stderr，避免污染客户端日志
        if (level === 'error') {
            process.stderr.write(logMessage);
        }

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
        this.writeLog('info' as LogLevel, '[LOG]', message);
    }

    /**
     * Log warning message
     */
    warn(...args: any[]): void {
        const message = args.map(arg => 
            typeof arg === 'object' ? this.safeStringify(arg) : String(arg)
        ).join(' ');
        this.writeLog('warn' as LogLevel, '[WARN]', message);
    }

    /**
     * Log error message
     */
    error(...args: any[]): void {
        const message = args.map(arg => 
            typeof arg === 'object' ? this.safeStringify(arg) : String(arg)
        ).join(' ');
        this.writeLog('error' as LogLevel, '[ERROR]', message);
    }

    /**
     * Log debug message
     */
    debug(...args: any[]): void {
        const message = args.map(arg => 
            typeof arg === 'object' ? this.safeStringify(arg) : String(arg)
        ).join(' ');
        this.writeLog('debug' as LogLevel, '[DEBUG]', message);
    }

    /**
     * Write detailed information to file log (not filtered by log level)
     * Use this for detailed debug info, performance data, search logs, etc.
     * Safe for concurrent access from multiple processes.
     */
    file(...args: any[]): void {
        if (!this.enableFileLogging || !this.logStream) {
            return;
        }

        const message = args.map(arg => 
            typeof arg === 'object' ? this.safeStringify(arg) : String(arg)
        ).join(' ');
        
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [FILE] ${message}\n`;

        try {
            // Use fs.appendFileSync for better concurrency safety
            // This is slower but ensures atomic writes
            fs.appendFileSync(this.currentLogFile, logMessage, 'utf8');
            
            // Update actual file size instead of tracking in memory
            // This is more accurate and safe for concurrent access
            this.updateCurrentLogSize();

            // Check if rotation is needed (less frequent to reduce I/O)
            if (this.currentLogSize >= this.maxLogSizeMB * 1024 * 1024) {
                this.rotateLog();
            }
        } catch (error) {
            process.stderr.write(`[LOGGER] Failed to write to log file: ${error}\n`);
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
    const envLogLevel = process.env.LOG_LEVEL?.toLowerCase();
    const validLogLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const logLevel: LogLevel | undefined = envLogLevel && validLogLevels.includes(envLogLevel as LogLevel) 
        ? (envLogLevel as LogLevel) 
        : undefined;
    
    const envConfig: LoggerConfig = {
        logDir: process.env.LOG_DIR,
        maxLogFiles: process.env.MAX_LOG_FILES ? parseInt(process.env.MAX_LOG_FILES, 10) : undefined,
        maxLogSizeMB: process.env.MAX_LOG_SIZE_MB ? parseInt(process.env.MAX_LOG_SIZE_MB, 10) : undefined,
        enableFileLogging: process.env.ENABLE_FILE_LOGGING !== 'false',
        logLevel: logLevel
    };
    
    // Merge with provided config (provided config takes precedence)
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
