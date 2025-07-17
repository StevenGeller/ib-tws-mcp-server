import { EventName, Position } from '@stoqey/ib';
import { z } from 'zod';
import { TWSConnection } from '../connection.js';

export const PortfolioTools = {
  getPositions: {
    name: 'getPositions',
    description: 'Get all portfolio positions',
    inputSchema: z.object({
      account: z.string().optional().describe('Account ID (optional, uses default if not specified)')
    }),
    execute: async (connection: TWSConnection, args: { account?: string }) => {
      const api = connection.getApi();
      const positions: Position[] = [];

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.position);
          api.removeAllListeners(EventName.positionEnd);
          reject(new Error('Timeout waiting for positions'));
        }, 10000);

        api.on(EventName.position, (account: string, contract: any, pos: number, avgCost: number) => {
          positions.push({
            account,
            contract,
            position: pos,
            avgCost,
            marketValue: 0, // Will be calculated
            unrealizedPNL: 0,
            realizedPNL: 0
          });
        });

        api.on(EventName.positionEnd, () => {
          clearTimeout(timeout);
          api.removeAllListeners(EventName.position);
          api.removeAllListeners(EventName.positionEnd);
          resolve({
            positions,
            count: positions.length
          });
        });

        api.reqPositions();
      });
    }
  },

  getAccountSummary: {
    name: 'getAccountSummary',
    description: 'Get account summary including balance, buying power, and P&L',
    inputSchema: z.object({
      account: z.string().optional().describe('Account ID (optional, uses default if not specified)'),
      tags: z.array(z.string()).optional().describe('Specific tags to retrieve (e.g., NetLiquidation, BuyingPower)')
    }),
    execute: async (connection: TWSConnection, args: { account?: string; tags?: string[] }) => {
      const api = connection.getApi();
      const summary: Record<string, any> = {};
      const reqId = Math.floor(Math.random() * 10000);

      const defaultTags = [
        'NetLiquidation',
        'TotalCashValue',
        'BuyingPower',
        'UnrealizedPnL',
        'RealizedPnL',
        'AvailableFunds',
        'MaintMarginReq',
        'InitMarginReq'
      ];

      const tagsToRequest = args.tags && args.tags.length > 0 ? args.tags : defaultTags;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.accountSummary);
          api.removeAllListeners(EventName.accountSummaryEnd);
          reject(new Error('Timeout waiting for account summary'));
        }, 10000);

        api.on(EventName.accountSummary, (reqId: number, account: string, tag: string, value: string, currency: string) => {
          summary[tag] = {
            account,
            tag,
            value,
            currency
          };
        });

        api.on(EventName.accountSummaryEnd, (reqId: number) => {
          clearTimeout(timeout);
          api.removeAllListeners(EventName.accountSummary);
          api.removeAllListeners(EventName.accountSummaryEnd);
          api.cancelAccountSummary(reqId);
          resolve(summary);
        });

        api.reqAccountSummary(reqId, 'All', tagsToRequest.join(','));
      });
    }
  },

  getPortfolioUpdates: {
    name: 'getPortfolioUpdates',
    description: 'Subscribe to real-time portfolio updates for an account',
    inputSchema: z.object({
      account: z.string().describe('Account ID to monitor'),
      subscribe: z.boolean().default(true).describe('True to subscribe, false to unsubscribe')
    }),
    execute: async (connection: TWSConnection, args: { account: string; subscribe: boolean }) => {
      const api = connection.getApi();

      if (args.subscribe) {
        const updates: any[] = [];
        
        return new Promise((resolve) => {
          api.on(EventName.updatePortfolio, (contract: any, position: number, marketPrice: number, 
            marketValue: number, avgCost: number, unrealizedPNL: number, realizedPNL: number, account: string) => {
            updates.push({
              contract,
              position,
              marketPrice,
              marketValue,
              avgCost,
              unrealizedPNL,
              realizedPNL,
              account,
              timestamp: new Date().toISOString()
            });
          });

          api.reqAccountUpdates(true, args.account);

          // Return initial snapshot after 2 seconds
          setTimeout(() => {
            resolve({
              message: 'Subscribed to portfolio updates',
              account: args.account,
              initialSnapshot: updates
            });
          }, 2000);
        });
      } else {
        api.reqAccountUpdates(false, args.account);
        return { message: 'Unsubscribed from portfolio updates', account: args.account };
      }
    }
  }
};