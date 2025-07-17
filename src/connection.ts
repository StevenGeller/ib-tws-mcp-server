import { IBApi, EventName, Contract, ErrorCode } from '@stoqey/ib';
import { z } from 'zod';

export const ConnectionConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().default(7497), // TWS paper trading port
  clientId: z.number().default(0),
  account: z.string().optional()
});

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

export class TWSConnection {
  private api: IBApi;
  private connected: boolean = false;
  private config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.api = new IBApi();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.api.connect(this.config.host, this.config.port, this.config.clientId);
      this.connected = true;
      
      // Subscribe to important events
      this.api.on(EventName.error, (err: Error, code: ErrorCode, reqId: number) => {
        console.error(`TWS Error [${code}] ReqId: ${reqId}:`, err.message);
      });

      this.api.on(EventName.connected, () => {
        console.log('Connected to TWS');
      });

      this.api.on(EventName.disconnected, () => {
        console.log('Disconnected from TWS');
        this.connected = false;
      });

    } catch (error) {
      this.connected = false;
      throw new Error(`Failed to connect to TWS: ${error}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.api.disconnect();
      this.connected = false;
    }
  }

  getApi(): IBApi {
    if (!this.connected) {
      throw new Error('Not connected to TWS');
    }
    return this.api;
  }

  isConnected(): boolean {
    return this.connected;
  }
}