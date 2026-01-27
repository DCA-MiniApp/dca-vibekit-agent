/**
 * MCP Client Manager with Automatic Reconnection
 * 
 * Handles connection resilience for the Ember MCP server by:
 * 1. Creating new client instances on session failures
 * 2. Detecting invalid session errors
 * 3. Providing automatic recovery without server restart
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

interface McpClientManagerConfig {
  endpoint: string;
  headers?: Record<string, string>;
  clientName: string;
  clientVersion: string;
  connectionTimeoutMs?: number;
}

export class McpClientManager {
  private client: Client | null = null;
  private config: McpClientManagerConfig;
  private isConnecting = false;
  private lastConnectionTime = 0;

  constructor(config: McpClientManagerConfig) {
    this.config = {
      ...config,
      connectionTimeoutMs: config.connectionTimeoutMs || 60000,
    };
  }

  /**
   * Get the current client, reconnecting if necessary
   */
  async getClient(): Promise<Client> {
    // If client exists, return it
    if (this.client) {
      return this.client;
    }

    // If already connecting, wait for connection to complete
    if (this.isConnecting) {
      let attempts = 0;
      const maxAttempts = 50; // Wait up to 5 seconds
      while (this.isConnecting && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      if (this.client) {
        return this.client;
      }
      throw new Error('Failed to establish MCP client connection');
    }

    // Otherwise, create new connection
    return this.connect();
  }

  /**
   * Establish a new connection to the MCP server
   */
  private async connect(): Promise<Client> {
    this.isConnecting = true;
    try {
      const client = new Client(
        { name: this.config.clientName, version: this.config.clientVersion },
        { capabilities: {} }
      );

      const transport = new StreamableHTTPClientTransport(
        new URL(this.config.endpoint),
        this.config.headers
      );

      const connectionPromise = client.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`MCP connection timeout after ${this.config.connectionTimeoutMs}ms`)),
          this.config.connectionTimeoutMs
        )
      );

      await Promise.race([connectionPromise, timeoutPromise]);

      this.client = client;
      this.lastConnectionTime = Date.now();
      console.log(`[MCP Manager] ✅ Connected to ${this.config.endpoint}`);
      return client;
    } catch (error) {
      this.client = null;
      console.error('[MCP Manager] ❌ Connection failed:', error);
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Check if error indicates a session/connection issue that requires reconnection
   */
  static isSessionError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('no valid session id') ||
      message.includes('session not found') ||
      message.includes('invalid session') ||
      message.includes('connection reset') ||
      message.includes('econnreset') ||
      message.includes('socket hang up') ||
      message.includes('http 400') ||
      message.includes('http 503')
    );
  }

  /**
   * Reset the client connection on session error
   * This forces a new connection on the next call
   */
  resetConnection(): void {
    if (this.client) {
      try {
        this.client.close?.();
      } catch (e) {
        // Ignore close errors
      }
      this.client = null;
    }
    console.log('[MCP Manager] 🔄 Connection reset - will reconnect on next request');
  }

  /**
   * Get connection uptime in seconds
   */
  getUptimeSeconds(): number {
    if (!this.lastConnectionTime) return 0;
    return Math.floor((Date.now() - this.lastConnectionTime) / 1000);
  }

  /**
   * Close the client connection cleanly
   */
  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close?.();
      } catch (e) {
        console.error('[MCP Manager] Error closing client:', e);
      }
      this.client = null;
    }
  }
}
