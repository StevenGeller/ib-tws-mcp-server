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

// Configuration
const CONFIG = {
  MAX_ORDER_QUANTITY: 10000,
  MAX_REQUESTS_PER_SECOND: 40, // Below IB's 50/sec limit
  REQUEST_TIMEOUT: 10000,
  MIN_LIMIT_PRICE: 0.01,
  MAX_LIMIT_PRICE: 999999,
  ALLOWED_SYMBOLS: /^[A-Z0-9]+$/, // Alphanumeric only
  ENABLE_LIVE_TRADING: true, // Set to false to disable order placement
};

// Server configuration
const serverInfo = {
  name: 'ib-tws-mcp-server',
  version: '1.1.0',
  description: 'Secure MCP server for Interactive Brokers TWS API'
};

// Connection state
let ib: IBApi | null = null;
let isConnected = false;
let activeSubscriptions = new Map<number, { type: string; timestamp: number }>();
let requestCounter = 10000;
let requestTimestamps: number[] = [];
let eventListenerCleanup: Map<string, Function> = new Map();

// Initialize MCP server
const server = new Server(serverInfo, {
  capabilities: {
    tools: {}
  }
});

// Helper: Rate limiting
function checkRateLimit(): void {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(ts => now - ts < 1000);
  
  if (requestTimestamps.length >= CONFIG.MAX_REQUESTS_PER_SECOND) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Rate limit exceeded. Max ${CONFIG.MAX_REQUESTS_PER_SECOND} requests per second.`
    );
  }
  
  requestTimestamps.push(now);
}

// Helper: Get next request ID
function getNextReqId(): number {
  checkRateLimit();
  return requestCounter++;
}

// Helper: Validate symbol
function validateSymbol(symbol: string): void {
  if (!CONFIG.ALLOWED_SYMBOLS.test(symbol)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid symbol format. Only alphanumeric characters allowed.`
    );
  }
}

// Helper: Clean up event listeners
function cleanupListeners(eventNames: string[], reqId?: number): void {
  if (!ib) return;
  
  eventNames.forEach(eventName => {
    const key = `${eventName}-${reqId || 'global'}`;
    const cleanup = eventListenerCleanup.get(key);
    if (cleanup) {
      cleanup();
      eventListenerCleanup.delete(key);
    }
  });
}

// Helper: Add event listener with cleanup tracking
function addListener(eventName: string, handler: Function, reqId?: number): void {
  if (!ib) return;
  
  ib.on(eventName as any, handler as any);
  const key = `${eventName}-${reqId || 'global'}`;
  
  eventListenerCleanup.set(key, () => {
    ib!.removeListener(eventName as any, handler as any);
  });
}

// Tool schemas with enhanced validation
const connectSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().min(1).max(65535).default(7497),
  clientId: z.number().min(0).max(999).default(0)
});

const orderSchema = z.object({
  symbol: z.string().min(1).max(12),
  action: z.enum(['BUY', 'SELL']),
  quantity: z.number().min(1).max(CONFIG.MAX_ORDER_QUANTITY),
  orderType: z.enum(['MKT', 'LMT']).default('MKT'),
  limitPrice: z.number().min(CONFIG.MIN_LIMIT_PRICE).max(CONFIG.MAX_LIMIT_PRICE).optional(),
  tif: z.enum(['DAY', 'GTC', 'IOC']).default('DAY'),
  testOrder: z.boolean().default(false).describe('If true, validates but does not submit order')
});

// Enhanced tools definition
const tools = [
  {
    name: 'connect',
    description: 'Connect to TWS/IB Gateway (7497=paper, 7496=live)',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', default: '127.0.0.1', description: 'TWS host' },
        port: { type: 'number', default: 7497, description: 'Port number' },
        clientId: { type: 'number', default: 0, description: 'Client ID (0-999)' }
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
    name: 'connectionStatus',
    description: 'Check connection status',
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
    description: 'Get account summary (balance, buying power, etc)',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { 
          type: 'array',
          items: { type: 'string' },
          description: 'Specific tags (default: NetLiquidation, BuyingPower, etc)'
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
        symbol: { type: 'string', description: 'Symbol (e.g., AAPL)' },
        secType: { type: 'string', enum: ['STK', 'IND'], default: 'STK' }
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
        expiration: { type: 'string', description: 'Optional expiration (YYYYMMDD)' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'placeOrder',
    description: CONFIG.ENABLE_LIVE_TRADING ? 
      'Place order (with safety limits)' : 
      'Order placement disabled',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol to trade' },
        action: { type: 'string', enum: ['BUY', 'SELL'] },
        quantity: { type: 'number', description: `Shares (max: ${CONFIG.MAX_ORDER_QUANTITY})` },
        orderType: { type: 'string', enum: ['MKT', 'LMT'], default: 'MKT' },
        limitPrice: { type: 'number', description: 'Required for LMT orders' },
        tif: { type: 'string', enum: ['DAY', 'GTC', 'IOC'], default: 'DAY' },
        testOrder: { type: 'boolean', default: false, description: 'Validate without submitting' }
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

// Handle tool execution with enhanced error handling
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'connect': {
        const config = connectSchema.parse(args);
        
        // Warn about live trading
        const isLivePort = config.port === 7496;
        
        if (ib) {
          await ib.disconnect();
          isConnected = false;
        }
        
        ib = new IBApi({
          host: config.host,
          port: config.port,
          clientId: config.clientId
        });
        
        // Set up global error handler
        addListener(EventName.error, (err: Error, code: number, reqId: number) => {
          console.error(`[${new Date().toISOString()}] TWS Error [${code}] ReqId ${reqId}: ${err.message}`);
          
          // Handle critical errors
          if (code === 504 || code === 502) { // Not connected
            isConnected = false;
          }
        });
        
        // Connection status monitoring
        addListener(EventName.connectionClosed, () => {
          console.error(`[${new Date().toISOString()}] Connection closed`);
          isConnected = false;
        });
        
        await ib.connect();
        isConnected = true;
        
        // Wait for connection to stabilize
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'connected',
              host: config.host,
              port: config.port,
              mode: isLivePort ? 'LIVE TRADING' : 'Paper Trading',
              warning: isLivePort ? 'Connected to LIVE trading. Orders will use REAL money!' : undefined,
              timestamp: new Date().toISOString()
            }, null, 2)
          }]
        };
      }

      case 'disconnect': {
        if (ib && isConnected) {
          // Clean up all subscriptions
          for (const [tickerId, sub] of activeSubscriptions) {
            if (sub.type === 'market') {
              ib.cancelMktData(tickerId);
            }
          }
          activeSubscriptions.clear();
          
          // Clean up all event listeners
          for (const cleanup of eventListenerCleanup.values()) {
            cleanup();
          }
          eventListenerCleanup.clear();
          
          await ib.disconnect();
          ib = null;
          isConnected = false;
          
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

      case 'connectionStatus': {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              connected: isConnected,
              activeSubscriptions: activeSubscriptions.size,
              uptime: isConnected && ib ? 'Active' : 'Disconnected'
            }, null, 2)
          }]
        };
      }

      case 'getPositions': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const positions: any[] = [];
        const reqId = getNextReqId();
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanupListeners([EventName.position, EventName.positionEnd], reqId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({ 
                  positions, 
                  count: positions.length,
                  timestamp: new Date().toISOString()
                }, null, 2)
              }]
            });
          }, CONFIG.REQUEST_TIMEOUT);

          const positionHandler = (account: string, contract: any, pos: number, avgCost: number) => {
            if (pos !== 0) { // Only show non-zero positions
              positions.push({
                account,
                symbol: contract.symbol,
                secType: contract.secType,
                position: pos,
                avgCost: avgCost.toFixed(2),
                marketValue: (pos * avgCost).toFixed(2)
              });
            }
          };

          const positionEndHandler = () => {
            clearTimeout(timeout);
            cleanupListeners([EventName.position, EventName.positionEnd], reqId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({ 
                  positions, 
                  count: positions.length,
                  timestamp: new Date().toISOString()
                }, null, 2)
              }]
            });
          };

          addListener(EventName.position, positionHandler, reqId);
          addListener(EventName.positionEnd, positionEndHandler, reqId);

          ib.reqPositions();
        });
      }

      case 'getAccountSummary': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const summary: any = {};
        const reqId = getNextReqId();
        const tags = (args as any).tags || [
          'NetLiquidation',
          'TotalCashValue',
          'BuyingPower',
          'UnrealizedPnL',
          'RealizedPnL',
          'MaintMarginReq'
        ];
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanupListeners([EventName.accountSummary, EventName.accountSummaryEnd], reqId);
            ib!.cancelAccountSummary(reqId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify(summary, null, 2)
              }]
            });
          }, CONFIG.REQUEST_TIMEOUT);

          const summaryHandler = (id: number, account: string, tag: string, value: string, currency: string) => {
            if (id === reqId) {
              summary[tag] = { 
                value: parseFloat(value).toFixed(2), 
                currency, 
                account: account.substring(0, 3) + '***' // Partial account masking
              };
            }
          };

          const summaryEndHandler = (id: number) => {
            if (id === reqId) {
              clearTimeout(timeout);
              cleanupListeners([EventName.accountSummary, EventName.accountSummaryEnd], reqId);
              ib!.cancelAccountSummary(reqId);
              resolve({
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    ...summary,
                    timestamp: new Date().toISOString()
                  }, null, 2)
                }]
              });
            }
          };

          addListener(EventName.accountSummary, summaryHandler, reqId);
          addListener(EventName.accountSummaryEnd, summaryEndHandler, reqId);

          ib.reqAccountSummary(reqId, 'All', tags.join(','));
        });
      }

      case 'getQuote': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const symbol = (args as any).symbol;
        validateSymbol(symbol);
        
        const tickerId = getNextReqId();
        const contract: Contract = {
          symbol,
          secType: (args as any).secType === 'IND' ? SecType.IND : SecType.STK,
          exchange: 'SMART',
          currency: 'USD'
        };
        
        const quote: any = { 
          symbol,
          timestamp: new Date().toISOString()
        };
        
        return new Promise((resolve, reject) => {
          activeSubscriptions.set(tickerId, { type: 'market', timestamp: Date.now() });
          
          const timeout = setTimeout(() => {
            ib!.cancelMktData(tickerId);
            activeSubscriptions.delete(tickerId);
            cleanupListeners([EventName.tickPrice, EventName.tickSize], tickerId);
            
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify(quote, null, 2)
              }]
            });
          }, 5000);

          let priceReceived = 0;
          
          const priceHandler = (id: number, tickType: number, price: number) => {
            if (id === tickerId && price > 0) {
              switch (tickType) {
                case 1: quote.bid = price.toFixed(2); priceReceived++; break;
                case 2: quote.ask = price.toFixed(2); priceReceived++; break;
                case 4: quote.last = price.toFixed(2); priceReceived++; break;
                case 6: quote.high = price.toFixed(2); break;
                case 7: quote.low = price.toFixed(2); break;
                case 9: quote.previousClose = price.toFixed(2); break;
              }
              
              if (priceReceived >= 3) {
                clearTimeout(timeout);
                ib!.cancelMktData(tickerId);
                activeSubscriptions.delete(tickerId);
                cleanupListeners([EventName.tickPrice, EventName.tickSize], tickerId);
                
                // Calculate spread
                if (quote.bid && quote.ask) {
                  quote.spread = (parseFloat(quote.ask) - parseFloat(quote.bid)).toFixed(2);
                }
                
                resolve({
                  content: [{
                    type: 'text',
                    text: JSON.stringify(quote, null, 2)
                  }]
                });
              }
            }
          };

          const sizeHandler = (id: number, tickType: number, size: bigint) => {
            if (id === tickerId) {
              switch (tickType) {
                case 0: quote.bidSize = Number(size); break;
                case 3: quote.askSize = Number(size); break;
                case 8: quote.volume = Number(size); break;
              }
            }
          };

          addListener(EventName.tickPrice, priceHandler, tickerId);
          addListener(EventName.tickSize, sizeHandler, tickerId);

          ib.reqMktData(tickerId, contract, '', false, false);
        });
      }

      case 'getOptionChain': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const symbol = (args as any).symbol;
        validateSymbol(symbol);
        
        const reqId = getNextReqId();
        const expiration = (args as any).expiration;
        
        return new Promise((resolve, reject) => {
          const chains: any[] = [];
          
          const timeout = setTimeout(() => {
            cleanupListeners([
              EventName.securityDefinitionOptionParameter,
              EventName.securityDefinitionOptionParameterEnd
            ], reqId);
            
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({ 
                  symbol,
                  chains,
                  totalExpirations: chains.reduce((sum, c) => sum + c.expirations.length, 0),
                  totalStrikes: chains.reduce((sum, c) => sum + c.strikes.length, 0)
                }, null, 2)
              }]
            });
          }, CONFIG.REQUEST_TIMEOUT);

          const optionParamHandler = (
            id: number,
            exchange: string,
            underlyingConId: number,
            tradingClass: string,
            multiplier: string,
            expirations: string[],
            strikes: number[]
          ) => {
            if (id === reqId) {
              const filteredExpirations = expiration 
                ? expirations.filter(exp => exp === expiration)
                : expirations.slice(0, 10); // Limit to first 10 expirations
                
              if (filteredExpirations.length > 0) {
                chains.push({
                  exchange,
                  tradingClass,
                  multiplier,
                  expirations: filteredExpirations,
                  strikes: strikes.filter(s => s > 0).sort((a, b) => a - b),
                  strikesCount: strikes.length
                });
              }
            }
          };

          const optionParamEndHandler = (id: number) => {
            if (id === reqId) {
              clearTimeout(timeout);
              cleanupListeners([
                EventName.securityDefinitionOptionParameter,
                EventName.securityDefinitionOptionParameterEnd
              ], reqId);
              
              resolve({
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    symbol,
                    chains,
                    totalExpirations: chains.reduce((sum, c) => sum + c.expirations.length, 0),
                    totalStrikes: chains.reduce((sum, c) => sum + c.strikes.length, 0),
                    timestamp: new Date().toISOString()
                  }, null, 2)
                }]
              });
            }
          };

          addListener(EventName.securityDefinitionOptionParameter, optionParamHandler, reqId);
          addListener(EventName.securityDefinitionOptionParameterEnd, optionParamEndHandler, reqId);

          ib.reqSecDefOptParams(reqId, symbol, '', 'STK', 0);
        });
      }

      case 'placeOrder': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        if (!CONFIG.ENABLE_LIVE_TRADING && !(args as any).testOrder) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            'Live trading is disabled. Use testOrder=true to validate only.'
          );
        }
        
        const params = orderSchema.parse(args);
        validateSymbol(params.symbol);
        
        // Additional validation for limit orders
        if (params.orderType === 'LMT' && !params.limitPrice) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Limit price required for limit orders'
          );
        }
        
        // Test mode - validate but don't submit
        if (params.testOrder) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'validated',
                message: 'Order validated successfully (not submitted)',
                order: params
              }, null, 2)
            }]
          };
        }
        
        const orderId = getNextReqId();
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
          tif: params.tif
        };
        
        if (params.orderType === 'LMT') {
          order.lmtPrice = params.limitPrice;
        }
        
        // Log order attempt
        console.log(`[${new Date().toISOString()}] Order attempt:`, {
          orderId,
          symbol: params.symbol,
          action: params.action,
          quantity: params.quantity,
          type: params.orderType,
          price: params.limitPrice
        });
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanupListeners([EventName.orderStatus, EventName.openOrder], orderId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({
                  orderId,
                  status: 'submitted',
                  message: 'Order submitted to TWS',
                  order: params,
                  timestamp: new Date().toISOString()
                }, null, 2)
              }]
            });
          }, 5000);

          const orderStatusHandler = (
            id: number,
            status: string,
            filled: number,
            remaining: number,
            avgFillPrice: number,
            permId: number,
            parentId: number,
            lastFillPrice: number,
            clientId: number,
            whyHeld: string
          ) => {
            if (id === orderId) {
              clearTimeout(timeout);
              cleanupListeners([EventName.orderStatus, EventName.openOrder], orderId);
              
              // Log order status
              console.log(`[${new Date().toISOString()}] Order status:`, {
                orderId,
                status,
                filled,
                avgFillPrice
              });
              
              resolve({
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    orderId,
                    status,
                    filled,
                    remaining,
                    avgFillPrice: avgFillPrice > 0 ? avgFillPrice.toFixed(2) : null,
                    symbol: params.symbol,
                    whyHeld: whyHeld || undefined,
                    timestamp: new Date().toISOString()
                  }, null, 2)
                }]
              });
            }
          };

          addListener(EventName.orderStatus, orderStatusHandler, orderId);
          
          ib.placeOrder(orderId, contract, order);
        });
      }

      case 'getOpenOrders': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const orders: any[] = [];
        const reqId = getNextReqId();
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanupListeners([EventName.openOrder, EventName.openOrderEnd], reqId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({ 
                  orders, 
                  count: orders.length,
                  timestamp: new Date().toISOString()
                }, null, 2)
              }]
            });
          }, CONFIG.REQUEST_TIMEOUT);

          const openOrderHandler = (orderId: number, contract: any, order: any, orderState: any) => {
            orders.push({
              orderId,
              symbol: contract.symbol,
              action: order.action,
              quantity: order.totalQuantity,
              orderType: order.orderType,
              limitPrice: order.lmtPrice ? order.lmtPrice.toFixed(2) : null,
              tif: order.tif,
              status: orderState.status,
              submitted: order.orderDate
            });
          };

          const openOrderEndHandler = () => {
            clearTimeout(timeout);
            cleanupListeners([EventName.openOrder, EventName.openOrderEnd], reqId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({ 
                  orders, 
                  count: orders.length,
                  timestamp: new Date().toISOString()
                }, null, 2)
              }]
            });
          };

          addListener(EventName.openOrder, openOrderHandler, reqId);
          addListener(EventName.openOrderEnd, openOrderEndHandler, reqId);

          ib.reqOpenOrders();
        });
      }

      case 'cancelOrder': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const orderId = (args as any).orderId;
        if (!orderId || orderId < 0) {
          throw new McpError(ErrorCode.InvalidParams, 'Valid order ID required');
        }
        
        // Log cancel attempt
        console.log(`[${new Date().toISOString()}] Cancel order attempt:`, { orderId });
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanupListeners([EventName.orderStatus], orderId);
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({
                  orderId,
                  status: 'cancel_requested',
                  message: 'Cancel request sent to TWS',
                  timestamp: new Date().toISOString()
                }, null, 2)
              }]
            });
          }, 3000);

          const cancelStatusHandler = (id: number, status: string) => {
            if (id === orderId && (status === 'Cancelled' || status === 'ApiCancelled')) {
              clearTimeout(timeout);
              cleanupListeners([EventName.orderStatus], orderId);
              
              console.log(`[${new Date().toISOString()}] Order cancelled:`, { orderId });
              
              resolve({
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    orderId,
                    status: 'cancelled',
                    message: 'Order successfully cancelled',
                    timestamp: new Date().toISOString()
                  }, null, 2)
                }]
              });
            }
          };

          addListener(EventName.orderStatus, cancelStatusHandler, orderId);
          
          ib.cancelOrder(orderId, '');
        });
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }
  } catch (error: any) {
    // Log errors
    console.error(`[${new Date().toISOString()}] Error in ${name}:`, error.message);
    
    if (error instanceof McpError) {
      throw error;
    }
    
    // Check for connection errors
    if (error.message.includes('Not connected') || error.message.includes('ECONNREFUSED')) {
      isConnected = false;
      throw new McpError(
        ErrorCode.InternalError,
        'Lost connection to TWS. Please reconnect.'
      );
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing ${name}: ${error.message}`
    );
  }
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] Unhandled Rejection:`, reason);
});

process.on('uncaughtException', (error) => {
  console.error(`[${new Date().toISOString()}] Uncaught Exception:`, error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error(`[${new Date().toISOString()}] Shutting down...`);
  
  if (ib && isConnected) {
    try {
      // Cancel all active subscriptions
      for (const [tickerId, sub] of activeSubscriptions) {
        if (sub.type === 'market') {
          ib.cancelMktData(tickerId);
        }
      }
      
      // Clean up event listeners
      for (const cleanup of eventListenerCleanup.values()) {
        cleanup();
      }
      
      await ib.disconnect();
    } catch (error) {
      console.error('Error during shutdown:', error);
    }
  }
  
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${new Date().toISOString()}] IB TWS MCP Server v${serverInfo.version} started`);
  console.error(`Rate limit: ${CONFIG.MAX_REQUESTS_PER_SECOND} requests/second`);
  console.error(`Max order quantity: ${CONFIG.MAX_ORDER_QUANTITY} shares`);
  console.error(`Live trading: ${CONFIG.ENABLE_LIVE_TRADING ? 'ENABLED' : 'DISABLED'}`);
}

main().catch((error) => {
  console.error('Server startup error:', error);
  process.exit(1);
});