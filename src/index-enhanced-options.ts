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
  MAX_REQUESTS_PER_SECOND: 40,
  REQUEST_TIMEOUT: 10000,
  MIN_LIMIT_PRICE: 0.01,
  MAX_LIMIT_PRICE: 999999,
  ALLOWED_SYMBOLS: /^[A-Z0-9]+$/,
  ENABLE_LIVE_TRADING: true,
  POSITION_DETAILS_BATCH_SIZE: 50, // Request details for up to 50 positions at once
};

// Server configuration
const serverInfo = {
  name: 'ib-tws-mcp-server',
  version: '1.2.0',
  description: 'Professional MCP server for IB TWS with enhanced option support'
};

// Connection state
let ib: IBApi | null = null;
let isConnected = false;
let activeSubscriptions = new Map<number, { type: string; timestamp: number }>();
let requestCounter = 10000;
let requestTimestamps: number[] = [];
let eventListenerCleanup: Map<string, Function> = new Map();

// Position cache for Greeks calculation
let positionCache = new Map<string, any>();

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

// Helper: Calculate days to expiration
function daysToExpiration(expiration: string): number {
  const exp = new Date(
    parseInt(expiration.substring(0, 4)),
    parseInt(expiration.substring(4, 6)) - 1,
    parseInt(expiration.substring(6, 8))
  );
  const now = new Date();
  const diffTime = exp.getTime() - now.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Helper: Format option description
function formatOptionDescription(contract: any): string {
  if (contract.secType !== 'OPT') return '';
  
  const expiry = contract.lastTradeDateOrContractMonth;
  const formattedExpiry = expiry ? 
    `${expiry.substring(4, 6)}/${expiry.substring(6, 8)}/${expiry.substring(2, 4)}` : 
    'Unknown';
  
  return `${contract.symbol} ${formattedExpiry} ${contract.strike}${contract.right}`;
}

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
    name: 'getPositions',
    description: 'Get detailed portfolio positions with option Greeks',
    inputSchema: {
      type: 'object',
      properties: {
        includeGreeks: { 
          type: 'boolean', 
          default: true, 
          description: 'Include Greeks for option positions' 
        },
        groupByUnderlying: {
          type: 'boolean',
          default: false,
          description: 'Group options by underlying symbol'
        }
      }
    }
  },
  {
    name: 'getPositionDetails',
    description: 'Get detailed info for a specific position',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol' },
        conId: { type: 'number', description: 'Contract ID (optional)' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'getAccountSummary',
    description: 'Get account summary with option-specific metrics',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { 
          type: 'array',
          items: { type: 'string' },
          description: 'Tags (default includes option-specific metrics)'
        }
      }
    }
  },
  {
    name: 'getQuote',
    description: 'Get real-time quote with Greeks for options',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol' },
        secType: { type: 'string', enum: ['STK', 'OPT', 'IND'], default: 'STK' },
        expiration: { type: 'string', description: 'For options: YYYYMMDD' },
        strike: { type: 'number', description: 'For options: strike price' },
        right: { type: 'string', enum: ['C', 'P'], description: 'For options: C=Call, P=Put' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'getOptionChain',
    description: 'Get option chain with bid/ask for strikes',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Underlying symbol' },
        expiration: { type: 'string', description: 'Optional expiration (YYYYMMDD)' },
        includeGreeks: { type: 'boolean', default: false, description: 'Include Greeks (slower)' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'getPortfolioGreeks',
    description: 'Calculate aggregate Greeks for entire portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        byUnderlying: { type: 'boolean', default: true, description: 'Group by underlying' }
      }
    }
  },
  {
    name: 'placeOrder',
    description: 'Place order with enhanced option support',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol' },
        secType: { type: 'string', enum: ['STK', 'OPT'], default: 'STK' },
        action: { type: 'string', enum: ['BUY', 'SELL'] },
        quantity: { type: 'number', description: `Shares/contracts (max: ${CONFIG.MAX_ORDER_QUANTITY})` },
        orderType: { type: 'string', enum: ['MKT', 'LMT'], default: 'MKT' },
        limitPrice: { type: 'number', description: 'Required for LMT orders' },
        // Option-specific fields
        expiration: { type: 'string', description: 'For options: YYYYMMDD' },
        strike: { type: 'number', description: 'For options: strike price' },
        right: { type: 'string', enum: ['C', 'P'], description: 'For options: C=Call, P=Put' },
        tif: { type: 'string', enum: ['DAY', 'GTC', 'IOC'], default: 'DAY' },
        testOrder: { type: 'boolean', default: false }
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

  try {
    switch (name) {
      case 'connect': {
        const config = z.object({
          host: z.string().default('127.0.0.1'),
          port: z.number().default(7497),
          clientId: z.number().default(0)
        }).parse(args);
        
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
        
        // Set up error handler
        addListener(EventName.error, (err: Error, code: number, reqId: number) => {
          console.error(`[${new Date().toISOString()}] TWS Error [${code}] ReqId ${reqId}: ${err.message}`);
          if (code === 504 || code === 502) {
            isConnected = false;
          }
        });
        
        await ib.connect();
        isConnected = true;
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

      case 'getPositions': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const includeGreeks = (args as any).includeGreeks ?? true;
        const groupByUnderlying = (args as any).groupByUnderlying ?? false;
        
        const positions: any[] = [];
        const optionPositions: any[] = [];
        const stockPositions: any[] = [];
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(async () => {
            cleanupListeners([EventName.position, EventName.positionEnd]);
            
            // Process positions
            for (const pos of positions) {
              if (pos.contract.secType === 'OPT') {
                const optionPos = {
                  ...pos,
                  description: formatOptionDescription(pos.contract),
                  daysToExpiry: pos.contract.lastTradeDateOrContractMonth ? 
                    daysToExpiration(pos.contract.lastTradeDateOrContractMonth) : null,
                  contractDetails: {
                    symbol: pos.contract.symbol,
                    expiration: pos.contract.lastTradeDateOrContractMonth,
                    strike: pos.contract.strike,
                    right: pos.contract.right,
                    multiplier: pos.contract.multiplier || 100
                  }
                };
                optionPositions.push(optionPos);
              } else {
                stockPositions.push(pos);
              }
            }
            
            // Get Greeks for options if requested
            if (includeGreeks && optionPositions.length > 0) {
              await getGreeksForPositions(optionPositions);
            }
            
            // Group by underlying if requested
            let result: any;
            if (groupByUnderlying) {
              const grouped: any = {};
              
              // Add stocks
              for (const stock of stockPositions) {
                const symbol = stock.contract.symbol;
                if (!grouped[symbol]) {
                  grouped[symbol] = {
                    underlying: stock,
                    options: []
                  };
                }
              }
              
              // Add options
              for (const opt of optionPositions) {
                const symbol = opt.contract.symbol;
                if (!grouped[symbol]) {
                  grouped[symbol] = {
                    underlying: null,
                    options: []
                  };
                }
                grouped[symbol].options.push(opt);
              }
              
              // Calculate aggregate Greeks per underlying
              for (const symbol in grouped) {
                if (grouped[symbol].options.length > 0) {
                  grouped[symbol].aggregateGreeks = calculateAggregateGreeks(grouped[symbol].options);
                }
              }
              
              result = grouped;
            } else {
              result = {
                stocks: stockPositions,
                options: optionPositions,
                summary: {
                  totalPositions: positions.length,
                  stockPositions: stockPositions.length,
                  optionPositions: optionPositions.length
                }
              };
            }
            
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }]
            });
          }, CONFIG.REQUEST_TIMEOUT);

          const positionHandler = (account: string, contract: any, pos: number, avgCost: number) => {
            if (pos !== 0) {
              const position = {
                account,
                contract,
                position: pos,
                avgCost: avgCost,
                marketValue: 0, // Will be updated with market data
                unrealizedPnL: 0
              };
              
              positions.push(position);
              
              // Cache for later Greeks retrieval
              const key = `${contract.symbol}-${contract.lastTradeDateOrContractMonth}-${contract.strike}-${contract.right}`;
              positionCache.set(key, position);
            }
          };

          const positionEndHandler = () => {
            // Don't clear timeout here, let it run to fetch Greeks
          };

          addListener(EventName.position, positionHandler);
          addListener(EventName.positionEnd, positionEndHandler);

          ib.reqPositions();
        });
      }

      case 'getPositionDetails': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const symbol = (args as any).symbol;
        const conId = (args as any).conId;
        validateSymbol(symbol);
        
        // Find position in cache
        let position = null;
        for (const [key, pos] of positionCache) {
          if (pos.contract.symbol === symbol && (!conId || pos.contract.conId === conId)) {
            position = pos;
            break;
          }
        }
        
        if (!position) {
          throw new McpError(ErrorCode.InvalidParams, 'Position not found');
        }
        
        const tickerId = getNextReqId();
        const details: any = {
          position: position.position,
          avgCost: position.avgCost,
          contract: position.contract
        };
        
        return new Promise((resolve, reject) => {
          activeSubscriptions.set(tickerId, { type: 'market', timestamp: Date.now() });
          
          const timeout = setTimeout(() => {
            ib!.cancelMktData(tickerId);
            activeSubscriptions.delete(tickerId);
            cleanupListeners([EventName.tickPrice, EventName.tickOptionComputation], tickerId);
            
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify(details, null, 2)
              }]
            });
          }, 5000);

          // Price handler
          const priceHandler = (id: number, tickType: number, price: number) => {
            if (id === tickerId && price > 0) {
              switch (tickType) {
                case 1: details.bid = price; break;
                case 2: details.ask = price; break;
                case 4: details.last = price; break;
              }
              
              // Calculate P&L
              if (details.last) {
                const multiplier = position.contract.multiplier || (position.contract.secType === 'OPT' ? 100 : 1);
                details.marketValue = position.position * details.last * multiplier;
                details.unrealizedPnL = details.marketValue - (position.position * position.avgCost * multiplier);
                details.unrealizedPnLPercent = (details.unrealizedPnL / (position.position * position.avgCost * multiplier) * 100).toFixed(2);
              }
            }
          };

          // Option computation handler for Greeks
          if (position.contract.secType === 'OPT') {
            const greeksHandler = (
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
                details.greeks = {
                  delta: delta > -2 && delta < 2 ? delta : null,
                  gamma: gamma > -2 && gamma < 2 ? gamma : null,
                  vega: vega > -2 && vega < 2 ? vega : null,
                  theta: theta > -2 && theta < 2 ? theta : null,
                  impliedVol: impliedVol > 0 ? impliedVol : null,
                  underlyingPrice: undPrice > 0 ? undPrice : null
                };
                
                // Calculate position Greeks
                if (details.greeks.delta !== null) {
                  details.positionGreeks = {
                    delta: (details.greeks.delta * position.position * 100).toFixed(2),
                    gamma: details.greeks.gamma ? (details.greeks.gamma * position.position * 100).toFixed(4) : null,
                    vega: details.greeks.vega ? (details.greeks.vega * position.position).toFixed(2) : null,
                    theta: details.greeks.theta ? (details.greeks.theta * position.position).toFixed(2) : null
                  };
                }
                
                clearTimeout(timeout);
                ib!.cancelMktData(tickerId);
                activeSubscriptions.delete(tickerId);
                cleanupListeners([EventName.tickPrice, EventName.tickOptionComputation], tickerId);
                
                resolve({
                  content: [{
                    type: 'text',
                    text: JSON.stringify(details, null, 2)
                  }]
                });
              }
            };
            
            addListener(EventName.tickOptionComputation, greeksHandler, tickerId);
          }

          addListener(EventName.tickPrice, priceHandler, tickerId);
          
          ib.reqMktData(tickerId, position.contract, '', false, false);
        });
      }

      case 'getPortfolioGreeks': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const byUnderlying = (args as any).byUnderlying ?? true;
        
        // First get all positions
        const positions: any[] = [];
        
        return new Promise(async (resolve, reject) => {
          const timeout = setTimeout(async () => {
            cleanupListeners([EventName.position, EventName.positionEnd]);
            
            // Filter option positions
            const optionPositions = positions.filter(p => p.contract.secType === 'OPT');
            
            if (optionPositions.length === 0) {
              resolve({
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    message: 'No option positions found',
                    timestamp: new Date().toISOString()
                  }, null, 2)
                }]
              });
              return;
            }
            
            // Get Greeks for all option positions
            await getGreeksForPositions(optionPositions);
            
            // Calculate aggregate Greeks
            let result: any;
            
            if (byUnderlying) {
              const bySymbol: any = {};
              
              for (const pos of optionPositions) {
                const symbol = pos.contract.symbol;
                if (!bySymbol[symbol]) {
                  bySymbol[symbol] = {
                    positions: [],
                    aggregateGreeks: {
                      delta: 0,
                      gamma: 0,
                      vega: 0,
                      theta: 0
                    },
                    totalMarketValue: 0,
                    totalUnrealizedPnL: 0
                  };
                }
                
                bySymbol[symbol].positions.push(pos);
                
                if (pos.greeks) {
                  const multiplier = pos.position * (pos.contract.multiplier || 100);
                  bySymbol[symbol].aggregateGreeks.delta += (pos.greeks.delta || 0) * multiplier;
                  bySymbol[symbol].aggregateGreeks.gamma += (pos.greeks.gamma || 0) * multiplier;
                  bySymbol[symbol].aggregateGreeks.vega += (pos.greeks.vega || 0) * pos.position;
                  bySymbol[symbol].aggregateGreeks.theta += (pos.greeks.theta || 0) * pos.position;
                }
                
                bySymbol[symbol].totalMarketValue += pos.marketValue || 0;
                bySymbol[symbol].totalUnrealizedPnL += pos.unrealizedPnL || 0;
              }
              
              // Format aggregate Greeks
              for (const symbol in bySymbol) {
                const agg = bySymbol[symbol].aggregateGreeks;
                bySymbol[symbol].aggregateGreeks = {
                  delta: agg.delta.toFixed(2),
                  gamma: agg.gamma.toFixed(4),
                  vega: agg.vega.toFixed(2),
                  theta: agg.theta.toFixed(2),
                  dollarDelta: (agg.delta * (bySymbol[symbol].positions[0]?.greeks?.underlyingPrice || 0)).toFixed(2)
                };
              }
              
              result = bySymbol;
            } else {
              // Portfolio-wide Greeks
              const portfolioGreeks = {
                totalDelta: 0,
                totalGamma: 0,
                totalVega: 0,
                totalTheta: 0,
                byExpiration: {} as any
              };
              
              for (const pos of optionPositions) {
                if (pos.greeks) {
                  const multiplier = pos.position * (pos.contract.multiplier || 100);
                  portfolioGreeks.totalDelta += (pos.greeks.delta || 0) * multiplier;
                  portfolioGreeks.totalGamma += (pos.greeks.gamma || 0) * multiplier;
                  portfolioGreeks.totalVega += (pos.greeks.vega || 0) * pos.position;
                  portfolioGreeks.totalTheta += (pos.greeks.theta || 0) * pos.position;
                  
                  // Group by expiration
                  const exp = pos.contract.lastTradeDateOrContractMonth;
                  if (exp) {
                    if (!portfolioGreeks.byExpiration[exp]) {
                      portfolioGreeks.byExpiration[exp] = {
                        delta: 0,
                        gamma: 0,
                        vega: 0,
                        theta: 0,
                        positions: 0
                      };
                    }
                    
                    portfolioGreeks.byExpiration[exp].delta += (pos.greeks.delta || 0) * multiplier;
                    portfolioGreeks.byExpiration[exp].gamma += (pos.greeks.gamma || 0) * multiplier;
                    portfolioGreeks.byExpiration[exp].vega += (pos.greeks.vega || 0) * pos.position;
                    portfolioGreeks.byExpiration[exp].theta += (pos.greeks.theta || 0) * pos.position;
                    portfolioGreeks.byExpiration[exp].positions++;
                  }
                }
              }
              
              result = {
                portfolioGreeks: {
                  totalDelta: portfolioGreeks.totalDelta.toFixed(2),
                  totalGamma: portfolioGreeks.totalGamma.toFixed(4),
                  totalVega: portfolioGreeks.totalVega.toFixed(2),
                  totalTheta: portfolioGreeks.totalTheta.toFixed(2)
                },
                byExpiration: portfolioGreeks.byExpiration,
                optionPositions: optionPositions.length,
                timestamp: new Date().toISOString()
              };
            }
            
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }]
            });
          }, CONFIG.REQUEST_TIMEOUT);

          const positionHandler = (account: string, contract: any, pos: number, avgCost: number) => {
            if (pos !== 0) {
              positions.push({
                account,
                contract,
                position: pos,
                avgCost
              });
            }
          };

          addListener(EventName.position, positionHandler);
          addListener(EventName.positionEnd, () => {});

          ib.reqPositions();
        });
      }

      case 'getQuote': {
        if (!ib || !isConnected) {
          throw new McpError(ErrorCode.InternalError, 'Not connected to TWS');
        }
        
        const params = symbolSchema.parse(args);
        const tickerId = getNextReqId();
        
        let contract: Contract;
        
        if (params.secType === 'OPT') {
          if (!params.expiration || !params.strike || !params.right) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Options require expiration, strike, and right (C/P)'
            );
          }
          
          contract = {
            symbol: params.symbol,
            secType: SecType.OPT,
            exchange: 'SMART',
            currency: 'USD',
            lastTradeDateOrContractMonth: params.expiration,
            strike: params.strike,
            right: params.right as any
          };
        } else {
          contract = {
            symbol: params.symbol,
            secType: params.secType === 'IND' ? SecType.IND : SecType.STK,
            exchange: 'SMART',
            currency: 'USD'
          };
        }
        
        const quote: any = { 
          symbol: params.symbol,
          secType: params.secType,
          timestamp: new Date().toISOString()
        };
        
        if (params.secType === 'OPT') {
          quote.expiration = params.expiration;
          quote.strike = params.strike;
          quote.right = params.right;
          quote.description = formatOptionDescription(contract);
          quote.daysToExpiry = daysToExpiration(params.expiration!);
        }
        
        return new Promise((resolve, reject) => {
          activeSubscriptions.set(tickerId, { type: 'market', timestamp: Date.now() });
          
          const timeout = setTimeout(() => {
            ib!.cancelMktData(tickerId);
            activeSubscriptions.delete(tickerId);
            cleanupListeners([EventName.tickPrice, EventName.tickSize, EventName.tickOptionComputation], tickerId);
            
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify(quote, null, 2)
              }]
            });
          }, 5000);

          let priceReceived = 0;
          
          const priceHandler = (id: number, tickType: number, price: number) => {
            if (id === tickerId && price >= 0) {
              switch (tickType) {
                case 1: quote.bid = price.toFixed(2); priceReceived++; break;
                case 2: quote.ask = price.toFixed(2); priceReceived++; break;
                case 4: quote.last = price.toFixed(2); priceReceived++; break;
                case 6: quote.high = price.toFixed(2); break;
                case 7: quote.low = price.toFixed(2); break;
                case 9: quote.previousClose = price.toFixed(2); break;
              }
              
              if (priceReceived >= 3 && params.secType !== 'OPT') {
                clearTimeout(timeout);
                ib!.cancelMktData(tickerId);
                activeSubscriptions.delete(tickerId);
                cleanupListeners([EventName.tickPrice, EventName.tickSize], tickerId);
                
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

          // For options, also get Greeks
          if (params.secType === 'OPT') {
            const greeksHandler = (
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
                quote.greeks = {
                  delta: delta > -2 && delta < 2 ? delta.toFixed(4) : null,
                  gamma: gamma > -2 && gamma < 2 ? gamma.toFixed(6) : null,
                  vega: vega > -2 && vega < 2 ? vega.toFixed(4) : null,
                  theta: theta > -2 && theta < 2 ? theta.toFixed(4) : null,
                  impliedVolatility: impliedVol > 0 ? (impliedVol * 100).toFixed(2) + '%' : null,
                  underlyingPrice: undPrice > 0 ? undPrice.toFixed(2) : null
                };
                
                // Calculate additional metrics
                if (quote.greeks.underlyingPrice && quote.strike) {
                  const moneyness = parseFloat(quote.greeks.underlyingPrice) / quote.strike;
                  if (params.right === 'C') {
                    quote.moneyness = moneyness > 1.02 ? 'ITM' : moneyness < 0.98 ? 'OTM' : 'ATM';
                  } else {
                    quote.moneyness = moneyness < 0.98 ? 'ITM' : moneyness > 1.02 ? 'OTM' : 'ATM';
                  }
                  quote.intrinsicValue = params.right === 'C' ? 
                    Math.max(0, parseFloat(quote.greeks.underlyingPrice) - quote.strike).toFixed(2) :
                    Math.max(0, quote.strike - parseFloat(quote.greeks.underlyingPrice)).toFixed(2);
                }
                
                clearTimeout(timeout);
                ib!.cancelMktData(tickerId);
                activeSubscriptions.delete(tickerId);
                cleanupListeners([EventName.tickPrice, EventName.tickSize, EventName.tickOptionComputation], tickerId);
                
                resolve({
                  content: [{
                    type: 'text',
                    text: JSON.stringify(quote, null, 2)
                  }]
                });
              }
            };
            
            addListener(EventName.tickOptionComputation, greeksHandler, tickerId);
          }

          addListener(EventName.tickPrice, priceHandler, tickerId);
          addListener(EventName.tickSize, sizeHandler, tickerId);

          ib.reqMktData(tickerId, contract, '', false, false);
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
        let contract: Contract;
        
        if (params.secType === 'OPT') {
          if (!params.expiration || !params.strike || !params.right) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Options require expiration, strike, and right (C/P)'
            );
          }
          
          contract = {
            symbol: params.symbol,
            secType: SecType.OPT,
            exchange: 'SMART',
            currency: 'USD',
            lastTradeDateOrContractMonth: params.expiration,
            strike: params.strike,
            right: params.right as any,
            multiplier: 100
          };
        } else {
          contract = {
            symbol: params.symbol,
            secType: SecType.STK,
            exchange: 'SMART',
            currency: 'USD'
          };
        }
        
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
          secType: params.secType,
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
                    secType: params.secType,
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

      // Include other standard tools (disconnect, getAccountSummary, etc.)
      // ... [Previous tool implementations remain the same]

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Error in ${name}:`, error.message);
    
    if (error instanceof McpError) {
      throw error;
    }
    
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

// Helper function to get Greeks for multiple positions
async function getGreeksForPositions(positions: any[]): Promise<void> {
  if (!ib || positions.length === 0) return;
  
  const greeksPromises = positions.map(pos => {
    return new Promise<void>((resolve) => {
      const tickerId = getNextReqId();
      const timeout = setTimeout(() => {
        ib!.cancelMktData(tickerId);
        resolve();
      }, 3000);
      
      const greeksHandler = (
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
          pos.greeks = {
            delta: delta > -2 && delta < 2 ? delta : null,
            gamma: gamma > -2 && gamma < 2 ? gamma : null,
            vega: vega > -2 && vega < 2 ? vega : null,
            theta: theta > -2 && theta < 2 ? theta : null,
            impliedVol: impliedVol > 0 ? impliedVol : null,
            underlyingPrice: undPrice > 0 ? undPrice : null
          };
          
          clearTimeout(timeout);
          ib!.cancelMktData(tickerId);
          resolve();
        }
      };
      
      ib!.once(EventName.tickOptionComputation as any, greeksHandler);
      ib!.reqMktData(tickerId, pos.contract, '', false, false);
    });
  });
  
  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < greeksPromises.length; i += CONFIG.POSITION_DETAILS_BATCH_SIZE) {
    const batch = greeksPromises.slice(i, i + CONFIG.POSITION_DETAILS_BATCH_SIZE);
    await Promise.all(batch);
  }
}

// Helper function to calculate aggregate Greeks
function calculateAggregateGreeks(positions: any[]): any {
  const aggregate = {
    delta: 0,
    gamma: 0,
    vega: 0,
    theta: 0
  };
  
  for (const pos of positions) {
    if (pos.greeks) {
      const multiplier = pos.position * (pos.contract.multiplier || 100);
      aggregate.delta += (pos.greeks.delta || 0) * multiplier;
      aggregate.gamma += (pos.greeks.gamma || 0) * multiplier;
      aggregate.vega += (pos.greeks.vega || 0) * pos.position;
      aggregate.theta += (pos.greeks.theta || 0) * pos.position;
    }
  }
  
  return {
    delta: aggregate.delta.toFixed(2),
    gamma: aggregate.gamma.toFixed(4),
    vega: aggregate.vega.toFixed(2),
    theta: aggregate.theta.toFixed(2)
  };
}

// Tool schemas
const symbolSchema = z.object({
  symbol: z.string(),
  secType: z.enum(['STK', 'OPT', 'IND']).default('STK'),
  exchange: z.string().default('SMART'),
  currency: z.string().default('USD'),
  // Option-specific fields
  expiration: z.string().optional(),
  strike: z.number().optional(),
  right: z.enum(['C', 'P']).optional()
});

const orderSchema = z.object({
  symbol: z.string().min(1).max(12),
  secType: z.enum(['STK', 'OPT']).default('STK'),
  action: z.enum(['BUY', 'SELL']),
  quantity: z.number().min(1).max(CONFIG.MAX_ORDER_QUANTITY),
  orderType: z.enum(['MKT', 'LMT']).default('MKT'),
  limitPrice: z.number().min(CONFIG.MIN_LIMIT_PRICE).max(CONFIG.MAX_LIMIT_PRICE).optional(),
  // Option-specific fields
  expiration: z.string().optional(),
  strike: z.number().optional(),
  right: z.enum(['C', 'P']).optional(),
  tif: z.enum(['DAY', 'GTC', 'IOC']).default('DAY'),
  testOrder: z.boolean().default(false)
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
      for (const [tickerId, sub] of activeSubscriptions) {
        if (sub.type === 'market') {
          ib.cancelMktData(tickerId);
        }
      }
      
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