#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { IBApi, EventName, Contract, SecType, OrderAction, OrderType as IBOrderType, TimeInForce } from '@stoqey/ib';
import { z } from 'zod';

// Server configuration
const serverInfo = {
  name: 'ib-tws-mcp-server',
  version: '1.0.0',
  description: 'MCP server for Interactive Brokers TWS API integration'
};

// Connection instance and state
let ib: IBApi | null = null;
let activeSubscriptions = new Map<number, string>();
let requestCounter = 1000;

// Initialize MCP server
const server = new Server(serverInfo, {
  capabilities: {
    tools: {}
  }
});

// Helper function to get next request ID
function getNextReqId(): number {
  return requestCounter++;
}

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

const optionChainSchema = z.object({
  symbol: z.string(),
  exchange: z.string().default('SMART'),
  expiration: z.string().optional().describe('Specific expiration (YYYYMMDD)')
});

const optionDetailsSchema = z.object({
  symbol: z.string(),
  expiration: z.string().describe('Expiration date (YYYYMMDD)'),
  strike: z.number(),
  right: z.enum(['C', 'P']).describe('C for Call, P for Put'),
  exchange: z.string().default('SMART')
});

const orderSchema = z.object({
  symbol: z.string(),
  action: z.enum(['BUY', 'SELL']),
  quantity: z.number(),
  orderType: z.enum(['MKT', 'LMT', 'STP', 'STP_LMT']).default('MKT'),
  limitPrice: z.number().optional(),
  stopPrice: z.number().optional(),
  tif: z.enum(['DAY', 'GTC', 'IOC']).default('DAY')
});

const historicalDataSchema = z.object({
  symbol: z.string(),
  secType: z.enum(['STK', 'IND']).default('STK'),
  duration: z.string().default('1 D').describe('e.g., "1 D", "1 W", "1 M"'),
  barSize: z.enum(['1 min', '5 mins', '15 mins', '30 mins', '1 hour', '1 day']).default('1 hour'),
  whatToShow: z.enum(['TRADES', 'MIDPOINT', 'BID', 'ASK']).default('TRADES')
});

// Tools definition
const tools = [
  {
    name: 'connect',
    description: 'Connect to TWS/IB Gateway',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', default: '127.0.0.1', description: 'TWS host' },
        port: { type: 'number', default: 7497, description: 'Port (7497=paper, 7496=live)' },
        clientId: { type: 'number', default: 0, description: 'Client ID' }
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
    name: 'getOptionChain',
    description: 'Get option chain for a symbol',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Underlying symbol' },
        exchange: { type: 'string', default: 'SMART' },
        expiration: { type: 'string', description: 'Optional specific expiration (YYYYMMDD)' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'getOptionQuote',
    description: 'Get quote for specific option contract',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Underlying symbol' },
        expiration: { type: 'string', description: 'Expiration (YYYYMMDD)' },
        strike: { type: 'number', description: 'Strike price' },
        right: { type: 'string', enum: ['C', 'P'], description: 'C=Call, P=Put' },
        exchange: { type: 'string', default: 'SMART' }
      },
      required: ['symbol', 'expiration', 'strike', 'right']
    }
  },
  {
    name: 'getHistoricalData',
    description: 'Get historical price data',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol' },
        secType: { type: 'string', enum: ['STK', 'IND'], default: 'STK' },
        duration: { type: 'string', default: '1 D', description: 'Duration (e.g., "1 D", "1 W")' },
        barSize: { type: 'string', enum: ['1 min', '5 mins', '15 mins', '30 mins', '1 hour', '1 day'], default: '1 hour' },
        whatToShow: { type: 'string', enum: ['TRADES', 'MIDPOINT', 'BID', 'ASK'], default: 'TRADES' }
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
        orderType: { type: 'string', enum: ['MKT', 'LMT', 'STP', 'STP_LMT'], default: 'MKT' },
        limitPrice: { type: 'number', description: 'Limit price for LMT orders' },
        stopPrice: { type: 'number', description: 'Stop price for STP orders' },
        tif: { type: 'string', enum: ['DAY', 'GTC', 'IOC'], default: 'DAY', description: 'Time in force' }
      },
      required: ['symbol', 'action', 'quantity']
    }
  },
  {
    name: 'getOpenOrders',
    description: 'Get all open orders',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'cancelOrder',
    description: 'Cancel an order',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number', description: 'Order ID to cancel' }
      },
      required: ['orderId']
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

  try {
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
        
        // Set up error handler
        ib.on(EventName.error, (err: Error, code: number, reqId: number) => {
          console.error(`TWS Error [${code}] ReqId: ${reqId}:`, err.message);
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
          // Cancel all active subscriptions
          for (const [tickerId, type] of activeSubscriptions) {
            if (type === 'market') {
              ib.cancelMktData(tickerId);
            }
          }
          activeSubscriptions.clear();
          
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
        
        return new Promise((resolve, reject) => {
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
              secType: contract.secType,
              position: pos,
              avgCost,
              contractId: contract.conId
            });
          });

          ib.on(EventName.positionEnd, () => {
            clearTimeout(timeout);
            ib!.removeAllListeners(EventName.position);
            ib!.removeAllListeners(EventName.positionEnd);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({ positions, count: positions.length }, null, 2)
              }]
            });
          });

          ib.reqPositions();
        });
      }

      case 'getAccountSummary': {
        if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        
        const summary: any = {};
        const reqId = getNextReqId();
        const tags = (args as any).tags || ['NetLiquidation', 'TotalCashValue', 'BuyingPower', 'UnrealizedPnL', 'RealizedPnL'];
        
        return new Promise((resolve, reject) => {
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
        const tickerId = getNextReqId();
        
        const contract: Contract = {
          symbol: params.symbol,
          secType: params.secType === 'STK' ? SecType.STK : 
                   params.secType === 'IND' ? SecType.IND : SecType.OPT,
          exchange: params.exchange,
          currency: params.currency
        };
        
        const quote: any = { 
          symbol: params.symbol,
          secType: params.secType,
          timestamp: new Date().toISOString()
        };
        
        return new Promise((resolve, reject) => {
          let dataReceived = 0;
          activeSubscriptions.set(tickerId, 'market');
          
          const timeout = setTimeout(() => {
            ib!.cancelMktData(tickerId);
            activeSubscriptions.delete(tickerId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify(quote, null, 2)
              }]
            });
          }, 3000);

          ib.on(EventName.tickPrice, (id: number, tickType: number, price: number) => {
            if (id === tickerId && price > 0) {
              switch (tickType) {
                case 1: quote.bid = price; dataReceived++; break;
                case 2: quote.ask = price; dataReceived++; break;
                case 4: quote.last = price; dataReceived++; break;
                case 6: quote.high = price; break;
                case 7: quote.low = price; break;
                case 9: quote.close = price; break;
              }
              
              if (dataReceived >= 3) {
                clearTimeout(timeout);
                ib!.cancelMktData(tickerId);
                activeSubscriptions.delete(tickerId);
                resolve({
                  content: [{
                    type: 'text',
                    text: JSON.stringify(quote, null, 2)
                  }]
                });
              }
            }
          });

          ib.on(EventName.tickSize, (id: number, tickType: number, size: bigint) => {
            if (id === tickerId) {
              switch (tickType) {
                case 0: quote.bidSize = Number(size); break;
                case 3: quote.askSize = Number(size); break;
                case 5: quote.lastSize = Number(size); break;
                case 8: quote.volume = Number(size); break;
              }
            }
          });

          ib.reqMktData(tickerId, contract, '', false, false);
        });
      }

      case 'getOptionChain': {
        if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        
        const params = optionChainSchema.parse(args);
        const reqId = getNextReqId();
        
        return new Promise((resolve, reject) => {
          const chains: any[] = [];
          
          const timeout = setTimeout(() => {
            ib!.removeAllListeners(EventName.securityDefinitionOptionParameter);
            ib!.removeAllListeners(EventName.securityDefinitionOptionParameterEnd);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({ 
                  symbol: params.symbol,
                  chains,
                  count: chains.length 
                }, null, 2)
              }]
            });
          }, 10000);

          ib.on(EventName.securityDefinitionOptionParameter, (
            id: number,
            exchange: string,
            underlyingConId: number,
            tradingClass: string,
            multiplier: string,
            expirations: string[],
            strikes: number[]
          ) => {
            if (id === reqId) {
              const filteredExpirations = params.expiration 
                ? expirations.filter(exp => exp === params.expiration)
                : expirations;
                
              chains.push({
                exchange,
                underlyingConId,
                tradingClass,
                multiplier,
                expirations: filteredExpirations,
                strikes: strikes.sort((a, b) => a - b),
                symbol: params.symbol
              });
            }
          });

          ib.on(EventName.securityDefinitionOptionParameterEnd, (id: number) => {
            if (id === reqId) {
              clearTimeout(timeout);
              ib!.removeAllListeners(EventName.securityDefinitionOptionParameter);
              ib!.removeAllListeners(EventName.securityDefinitionOptionParameterEnd);
              resolve({
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    symbol: params.symbol,
                    chains,
                    count: chains.length
                  }, null, 2)
                }]
              });
            }
          });

          ib.reqSecDefOptParams(reqId, params.symbol, params.exchange, 'STK', 0);
        });
      }

      case 'getOptionQuote': {
        if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        
        const params = optionDetailsSchema.parse(args);
        const tickerId = getNextReqId();
        
        const contract: Contract = {
          symbol: params.symbol,
          secType: SecType.OPT,
          exchange: params.exchange,
          currency: 'USD',
          lastTradeDateOrContractMonth: params.expiration,
          strike: params.strike,
          right: params.right
        };
        
        const quote: any = { 
          symbol: params.symbol,
          expiration: params.expiration,
          strike: params.strike,
          right: params.right,
          timestamp: new Date().toISOString()
        };
        
        return new Promise((resolve, reject) => {
          let dataReceived = 0;
          activeSubscriptions.set(tickerId, 'market');
          
          const timeout = setTimeout(() => {
            ib!.cancelMktData(tickerId);
            activeSubscriptions.delete(tickerId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify(quote, null, 2)
              }]
            });
          }, 5000);

          // Handle price ticks
          ib.on(EventName.tickPrice, (id: number, tickType: number, price: number) => {
            if (id === tickerId && price >= 0) {
              switch (tickType) {
                case 1: quote.bid = price; dataReceived++; break;
                case 2: quote.ask = price; dataReceived++; break;
                case 4: quote.last = price; dataReceived++; break;
              }
            }
          });

          // Handle option computation (Greeks)
          ib.on(EventName.tickOptionComputation, (
            id: number,
            tickType: number,
            tickAttrib: number,
            impliedVol: number,
            delta: number,
            optPrice: number,
            pvDividend: number,
            gamma: number,
            vega: number,
            theta: number,
            undPrice: number
          ) => {
            if (id === tickerId) {
              if (delta > -2 && delta < 2) quote.delta = delta;
              if (gamma > -2 && gamma < 2) quote.gamma = gamma;
              if (vega > -2 && vega < 2) quote.vega = vega;
              if (theta > -2 && theta < 2) quote.theta = theta;
              if (impliedVol > 0) quote.impliedVolatility = impliedVol;
              if (undPrice > 0) quote.underlyingPrice = undPrice;
              
              dataReceived++;
              
              if (dataReceived >= 4) {
                clearTimeout(timeout);
                ib!.cancelMktData(tickerId);
                activeSubscriptions.delete(tickerId);
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

      case 'getHistoricalData': {
        if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        
        const params = historicalDataSchema.parse(args);
        const reqId = getNextReqId();
        
        const contract: Contract = {
          symbol: params.symbol,
          secType: params.secType === 'IND' ? SecType.IND : SecType.STK,
          exchange: 'SMART',
          currency: 'USD'
        };
        
        return new Promise((resolve, reject) => {
          const bars: any[] = [];
          
          const timeout = setTimeout(() => {
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({
                  symbol: params.symbol,
                  duration: params.duration,
                  barSize: params.barSize,
                  bars,
                  count: bars.length
                }, null, 2)
              }]
            });
          }, 15000);

          ib.on(EventName.historicalData, (
            id: number,
            time: string,
            open: number,
            high: number,
            low: number,
            close: number,
            volume: bigint,
            count: number,
            WAP: number
          ) => {
            if (id === reqId) {
              bars.push({
                time,
                open,
                high,
                low,
                close,
                volume: Number(volume),
                count,
                wap: WAP
              });
            }
          });

          ib.on(EventName.historicalDataUpdate, (
            id: number,
            time: string,
            open: number,
            high: number,
            low: number,
            close: number,
            volume: bigint,
            count: number,
            WAP: number
          ) => {
            if (id === reqId) {
              clearTimeout(timeout);
              // Add the final bar if it's an update
              bars.push({
                time,
                open,
                high,
                low,
                close,
                volume: Number(volume),
                count,
                wap: WAP
              });
              
              resolve({
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    symbol: params.symbol,
                    duration: params.duration,
                    barSize: params.barSize,
                    bars,
                    count: bars.length
                  }, null, 2)
                }]
              });
            }
          });

          // Map bar sizes
          const barSizeMap: any = {
            '1 min': '1 min',
            '5 mins': '5 mins',
            '15 mins': '15 mins',
            '30 mins': '30 mins',
            '1 hour': '1 hour',
            '1 day': '1 day'
          };

          ib.reqHistoricalData(
            reqId,
            contract,
            '',
            params.duration,
            barSizeMap[params.barSize],
            params.whatToShow,
            1,
            1,
            false
          );
        });
      }

      case 'placeOrder': {
        if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        
        const params = orderSchema.parse(args);
        const orderId = getNextReqId();
        
        const contract: Contract = {
          symbol: params.symbol,
          secType: SecType.STK,
          exchange: 'SMART',
          currency: 'USD'
        };
        
        // Map order types
        const orderTypeMap: any = {
          'MKT': 'MKT',
          'LMT': 'LMT',
          'STP': 'STP',
          'STP_LMT': 'STP LMT'
        };
        
        const order: any = {
          orderId,
          action: params.action === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
          totalQuantity: params.quantity,
          orderType: orderTypeMap[params.orderType],
          tif: params.tif
        };
        
        // Add price fields based on order type
        if (params.orderType === 'LMT' || params.orderType === 'STP_LMT') {
          if (!params.limitPrice) {
            throw new McpError(ErrorCode.InvalidParams, 'Limit price required for limit orders');
          }
          order.lmtPrice = params.limitPrice;
        }
        
        if (params.orderType === 'STP' || params.orderType === 'STP_LMT') {
          if (!params.stopPrice) {
            throw new McpError(ErrorCode.InvalidParams, 'Stop price required for stop orders');
          }
          order.auxPrice = params.stopPrice;
        }
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({
                  orderId,
                  status: 'Order submitted',
                  symbol: params.symbol,
                  action: params.action,
                  quantity: params.quantity,
                  orderType: params.orderType
                }, null, 2)
              }]
            });
          }, 3000);

          ib.on(EventName.orderStatus, (
            id: number,
            status: string,
            filled: number,
            remaining: number,
            avgFillPrice: number,
            permId: number,
            parentId: number,
            lastFillPrice: number,
            clientId: number,
            whyHeld: string,
            mktCapPrice: number
          ) => {
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
                    symbol: params.symbol,
                    whyHeld: whyHeld || undefined
                  }, null, 2)
                }]
              });
            }
          });

          ib.placeOrder(orderId, contract, order);
        });
      }

      case 'getOpenOrders': {
        if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        
        const orders: any[] = [];
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            ib!.removeAllListeners(EventName.openOrder);
            ib!.removeAllListeners(EventName.openOrderEnd);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({ orders, count: orders.length }, null, 2)
              }]
            });
          }, 5000);

          ib.on(EventName.openOrder, (orderId: number, contract: any, order: any, orderState: any) => {
            orders.push({
              orderId,
              symbol: contract.symbol,
              secType: contract.secType,
              action: order.action,
              orderType: order.orderType,
              quantity: order.totalQuantity,
              limitPrice: order.lmtPrice,
              stopPrice: order.auxPrice,
              tif: order.tif,
              status: orderState.status,
              filled: order.filledQuantity,
              remaining: order.remainingQuantity
            });
          });

          ib.on(EventName.openOrderEnd, () => {
            clearTimeout(timeout);
            ib!.removeAllListeners(EventName.openOrder);
            ib!.removeAllListeners(EventName.openOrderEnd);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({ orders, count: orders.length }, null, 2)
              }]
            });
          });

          ib.reqOpenOrders();
        });
      }

      case 'cancelOrder': {
        if (!ib) throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        
        const orderId = (args as any).orderId;
        if (!orderId) {
          throw new McpError(ErrorCode.InvalidParams, 'Order ID required');
        }
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({
                  orderId,
                  status: 'Cancel request sent'
                }, null, 2)
              }]
            });
          }, 2000);

          ib.on(EventName.orderStatus, (id: number, status: string) => {
            if (id === orderId && (status === 'Cancelled' || status === 'ApiCancelled')) {
              clearTimeout(timeout);
              resolve({
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    orderId,
                    status: 'Cancelled',
                    message: 'Order successfully cancelled'
                  }, null, 2)
                }]
              });
            }
          });

          ib.cancelOrder(orderId, '');
        });
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }
  } catch (error: any) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing ${name}: ${error.message}`
    );
  }
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('Shutting down...');
  if (ib) {
    // Cancel all active subscriptions
    for (const [tickerId, type] of activeSubscriptions) {
      if (type === 'market') {
        ib.cancelMktData(tickerId);
      }
    }
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