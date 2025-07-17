#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { IBApi, EventName, Contract, SecType, OrderAction } from '@stoqey/ib';
import { z } from 'zod';

// Server configuration
const serverInfo = {
  name: 'ib-tws-mcp-server',
  version: '1.0.0',
  description: 'MCP server for Interactive Brokers TWS API integration'
};

// Connection instance
let ib: IBApi | null = null;

// Initialize MCP server
const server = new Server(serverInfo, {
  capabilities: {
    tools: {}
  }
});

// Tool schemas
const connectSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().default(7497),
  clientId: z.number().default(0)
});

const symbolSchema = z.object({
  symbol: z.string(),
  secType: z.enum(['STK', 'OPT', 'IND']).default('STK'),
  exchange: z.string().default('SMART'),
  currency: z.string().default('USD')
});

const orderSchema = z.object({
  symbol: z.string(),
  action: z.enum(['BUY', 'SELL']),
  quantity: z.number(),
  orderType: z.enum(['MKT', 'LMT']).default('MKT'),
  limitPrice: z.number().optional()
});

// Tools definition
const tools = [
  {
    name: 'connect',
    description: 'Connect to TWS/IB Gateway',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'number', default: 7497 },
        clientId: { type: 'number', default: 0 }
      }
    }
  },
  {
    name: 'disconnect',
    description: 'Disconnect from TWS/IB Gateway',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'getPositions',
    description: 'Get all portfolio positions',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'getAccountSummary',
    description: 'Get account summary',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { 
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to retrieve (e.g., NetLiquidation, BuyingPower)'
        }
      }
    }
  },
  {
    name: 'getQuote',
    description: 'Get real-time quote for a symbol',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol to quote' },
        secType: { type: 'string', enum: ['STK', 'OPT', 'IND'], default: 'STK' },
        exchange: { type: 'string', default: 'SMART' },
        currency: { type: 'string', default: 'USD' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'placeOrder',
    description: 'Place a new order',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol to trade' },
        action: { type: 'string', enum: ['BUY', 'SELL'] },
        quantity: { type: 'number', description: 'Number of shares' },
        orderType: { type: 'string', enum: ['MKT', 'LMT'], default: 'MKT' },
        limitPrice: { type: 'number', description: 'Limit price for LMT orders' }
      },
      required: ['symbol', 'action', 'quantity']
    }
  }
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'connect': {
      const config = connectSchema.parse(args);
      if (ib) {
        await ib.disconnect();
      }
      ib = new IBApi({
        host: config.host,
        port: config.port,
        clientId: config.clientId
      });
      
      await ib.connect();
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for connection
      
      return {
        content: [{
          type: 'text',
          text: `Connected to TWS at ${config.host}:${config.port}`
        }]
      };
    }

    case 'disconnect': {
      if (ib) {
        await ib.disconnect();
        ib = null;
        return {
          content: [{
            type: 'text',
            text: 'Disconnected from TWS'
          }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: 'Not connected'
        }]
      };
    }

    case 'getPositions': {
      if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
      
      const positions: any[] = [];
      
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          ib!.removeAllListeners(EventName.position);
          ib!.removeAllListeners(EventName.positionEnd);
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify({ positions }, null, 2)
            }]
          });
        }, 5000);

        ib.on(EventName.position, (account: string, contract: any, pos: number, avgCost: number) => {
          positions.push({
            account,
            symbol: contract.symbol,
            position: pos,
            avgCost
          });
        });

        ib.on(EventName.positionEnd, () => {
          clearTimeout(timeout);
          ib!.removeAllListeners(EventName.position);
          ib!.removeAllListeners(EventName.positionEnd);
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify({ positions }, null, 2)
            }]
          });
        });

        ib.reqPositions();
      });
    }

    case 'getAccountSummary': {
      if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
      
      const summary: any = {};
      const reqId = Math.floor(Math.random() * 10000);
      const tags = (args as any).tags || ['NetLiquidation', 'TotalCashValue', 'BuyingPower'];
      
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          ib!.removeAllListeners(EventName.accountSummary);
          ib!.removeAllListeners(EventName.accountSummaryEnd);
          ib!.cancelAccountSummary(reqId);
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify(summary, null, 2)
            }]
          });
        }, 5000);

        ib.on(EventName.accountSummary, (id: number, account: string, tag: string, value: string, currency: string) => {
          if (id === reqId) {
            summary[tag] = { value, currency, account };
          }
        });

        ib.on(EventName.accountSummaryEnd, (id: number) => {
          if (id === reqId) {
            clearTimeout(timeout);
            ib!.removeAllListeners(EventName.accountSummary);
            ib!.removeAllListeners(EventName.accountSummaryEnd);
            ib!.cancelAccountSummary(reqId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify(summary, null, 2)
              }]
            });
          }
        });

        ib.reqAccountSummary(reqId, 'All', tags.join(','));
      });
    }

    case 'getQuote': {
      if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
      
      const params = symbolSchema.parse(args);
      const tickerId = Math.floor(Math.random() * 10000);
      
      const contract: Contract = {
        symbol: params.symbol,
        secType: params.secType === 'STK' ? SecType.STK : 
                 params.secType === 'IND' ? SecType.IND : SecType.OPT,
        exchange: params.exchange,
        currency: params.currency
      };
      
      const quote: any = { symbol: params.symbol };
      
      return new Promise((resolve) => {
        let dataReceived = 0;
        
        const timeout = setTimeout(() => {
          ib!.cancelMktData(tickerId);
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify(quote, null, 2)
            }]
          });
        }, 3000);

        ib.on(EventName.tickPrice, (id: number, tickType: number, price: number) => {
          if (id === tickerId) {
            // Map tick types
            switch (tickType) {
              case 1: quote.bid = price; break;
              case 2: quote.ask = price; break;
              case 4: quote.last = price; break;
              case 6: quote.high = price; break;
              case 7: quote.low = price; break;
              case 9: quote.close = price; break;
            }
            dataReceived++;
            
            if (dataReceived >= 4) {
              clearTimeout(timeout);
              ib!.cancelMktData(tickerId);
              resolve({
                content: [{
                  type: 'text',
                  text: JSON.stringify(quote, null, 2)
                }]
              });
            }
          }
        });

        ib.reqMktData(tickerId, contract, '', false, false);
      });
    }

    case 'placeOrder': {
      if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
      
      const params = orderSchema.parse(args);
      const orderId = Math.floor(Math.random() * 100000);
      
      const contract: Contract = {
        symbol: params.symbol,
        secType: SecType.STK,
        exchange: 'SMART',
        currency: 'USD'
      };
      
      const order: any = {
        orderId,
        action: params.action === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
        totalQuantity: params.quantity,
        orderType: params.orderType,
        lmtPrice: params.limitPrice
      };
      
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify({
                orderId,
                status: 'Order submitted',
                symbol: params.symbol,
                action: params.action,
                quantity: params.quantity
              }, null, 2)
            }]
          });
        }, 2000);

        ib.on(EventName.orderStatus, (id: number, status: string, filled: number, remaining: number, avgFillPrice: number) => {
          if (id === orderId) {
            clearTimeout(timeout);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({
                  orderId,
                  status,
                  filled,
                  remaining,
                  avgFillPrice,
                  symbol: params.symbol
                }, null, 2)
              }]
            });
          }
        });

        ib.placeOrder(orderId, contract, order);
      });
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
  }
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (ib) {
    await ib.disconnect();
  }
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('IB TWS MCP Server started');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});