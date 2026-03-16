export class Logger {
  private prefix: string;
  constructor(prefix: string) { this.prefix = prefix; }
  info(...args: any[]) { console.error(`[${this.prefix}]`, ...args); }
  warn(...args: any[]) { console.error(`[${this.prefix}] WARN:`, ...args); }
  error(...args: any[]) { console.error(`[${this.prefix}] ERROR:`, ...args); }
  debug(...args: any[]) { if (process.env.KRATOS_DEBUG === 'true') console.error(`[${this.prefix}] DEBUG:`, ...args); }
}
