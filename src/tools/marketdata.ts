import { EventName, Contract, SecType, TickType, BarSizeSetting, WhatToShow } from '@stoqey/ib';
import { z } from 'zod';
import { TWSConnection } from '../connection.js';

export const MarketDataTools = {
  getQuote: {
    name: 'getQuote',
    description: 'Get real-time quote for a stock or index',
    inputSchema: z.object({
      symbol: z.string().describe('Symbol (e.g., AAPL, SPX)'),
      secType: z.enum(['STK', 'IND']).default('STK').describe('Security type: STK for stock, IND for index'),
      exchange: z.string().default('SMART').describe('Exchange (default: SMART)'),
      currency: z.string().default('USD').describe('Currency (default: USD)')
    }),
    execute: async (connection: TWSConnection, args: any) => {
      const api = connection.getApi();
      const tickerId = Math.floor(Math.random() * 10000);

      const contract: Contract = {
        symbol: args.symbol,
        secType: args.secType === 'IND' ? SecType.IND : SecType.STK,
        exchange: args.exchange || 'SMART',
        currency: args.currency || 'USD'
      };

      return new Promise((resolve, reject) => {
        const quote: any = {
          symbol: args.symbol,
          secType: args.secType,
          timestamp: new Date().toISOString()
        };
        
        let dataPoints = 0;
        const requiredDataPoints = 4; // bid, ask, last, volume
        
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.tickPrice);
          api.removeAllListeners(EventName.tickSize);
          api.cancelMktData(tickerId);
          if (dataPoints > 0) {
            resolve(quote);
          } else {
            reject(new Error('Timeout waiting for market data'));
          }
        }, 10000);

        api.on(EventName.tickPrice, (tickerId: number, tickType: TickType, price: number, attrib: any) => {
          switch (tickType) {
            case TickType.BID:
              quote.bid = price;
              dataPoints++;
              break;
            case TickType.ASK:
              quote.ask = price;
              dataPoints++;
              break;
            case TickType.LAST:
              quote.last = price;
              dataPoints++;
              break;
            case TickType.HIGH:
              quote.high = price;
              break;
            case TickType.LOW:
              quote.low = price;
              break;
            case TickType.CLOSE:
              quote.previousClose = price;
              break;
          }
          
          if (dataPoints >= requiredDataPoints) {
            clearTimeout(timeout);
            api.removeAllListeners(EventName.tickPrice);
            api.removeAllListeners(EventName.tickSize);
            api.cancelMktData(tickerId);
            resolve(quote);
          }
        });

        api.on(EventName.tickSize, (tickerId: number, tickType: TickType, size: bigint) => {
          switch (tickType) {
            case TickType.BID_SIZE:
              quote.bidSize = Number(size);
              break;
            case TickType.ASK_SIZE:
              quote.askSize = Number(size);
              break;
            case TickType.LAST_SIZE:
              quote.lastSize = Number(size);
              break;
            case TickType.VOLUME:
              quote.volume = Number(size);
              dataPoints++;
              break;
          }
        });

        api.reqMktData(tickerId, contract, '', false, false);
      });
    }
  },

  getHistoricalData: {
    name: 'getHistoricalData',
    description: 'Get historical price data for a stock or index',
    inputSchema: z.object({
      symbol: z.string().describe('Symbol (e.g., AAPL, SPX)'),
      secType: z.enum(['STK', 'IND']).default('STK').describe('Security type: STK for stock, IND for index'),
      duration: z.string().default('1 D').describe('Duration (e.g., "1 D", "1 W", "1 M")'),
      barSize: z.enum(['1 min', '5 mins', '15 mins', '30 mins', '1 hour', '1 day']).default('1 hour').describe('Bar size'),
      whatToShow: z.enum(['TRADES', 'MIDPOINT', 'BID', 'ASK']).default('TRADES').describe('What data to show'),
      exchange: z.string().default('SMART').describe('Exchange (default: SMART)')
    }),
    execute: async (connection: TWSConnection, args: any) => {
      const api = connection.getApi();
      const reqId = Math.floor(Math.random() * 10000);

      const contract: Contract = {
        symbol: args.symbol,
        secType: args.secType === 'IND' ? SecType.IND : SecType.STK,
        exchange: args.exchange || 'SMART',
        currency: 'USD'
      };

      const barSizeMap: Record<string, BarSizeSetting> = {
        '1 min': BarSizeSetting.MINUTES_ONE,
        '5 mins': BarSizeSetting.MINUTES_FIVE,
        '15 mins': BarSizeSetting.MINUTES_FIFTEEN,
        '30 mins': BarSizeSetting.MINUTES_THIRTY,
        '1 hour': BarSizeSetting.HOURS_ONE,
        '1 day': BarSizeSetting.DAYS_ONE
      };

      const whatToShowMap: Record<string, WhatToShow> = {
        'TRADES': WhatToShow.TRADES,
        'MIDPOINT': WhatToShow.MIDPOINT,
        'BID': WhatToShow.BID,
        'ASK': WhatToShow.ASK
      };

      return new Promise((resolve, reject) => {
        const bars: any[] = [];
        
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.historicalData);
          api.removeAllListeners(EventName.historicalDataEnd);
          reject(new Error('Timeout waiting for historical data'));
        }, 15000);

        api.on(EventName.historicalData, (reqId: number, time: string, open: number, high: number, 
          low: number, close: number, volume: bigint, count: number, WAP: number) => {
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
        });

        api.on(EventName.historicalDataEnd, (reqId: number, start: string, end: string) => {
          clearTimeout(timeout);
          api.removeAllListeners(EventName.historicalData);
          api.removeAllListeners(EventName.historicalDataEnd);
          resolve({
            symbol: args.symbol,
            duration: args.duration,
            barSize: args.barSize,
            bars,
            count: bars.length,
            startTime: start,
            endTime: end
          });
        });

        api.reqHistoricalData(
          reqId,
          contract,
          '',
          args.duration,
          barSizeMap[args.barSize],
          whatToShowMap[args.whatToShow],
          1,
          1,
          false
        );
      });
    }
  },

  streamMarketData: {
    name: 'streamMarketData',
    description: 'Subscribe to real-time streaming market data',
    inputSchema: z.object({
      symbol: z.string().describe('Symbol to stream'),
      secType: z.enum(['STK', 'IND']).default('STK').describe('Security type'),
      subscribe: z.boolean().default(true).describe('True to subscribe, false to unsubscribe'),
      tickerId: z.number().optional().describe('Ticker ID for unsubscribing')
    }),
    execute: async (connection: TWSConnection, args: any) => {
      const api = connection.getApi();
      
      if (!args.subscribe && args.tickerId) {
        api.cancelMktData(args.tickerId);
        return { message: 'Unsubscribed from market data', tickerId: args.tickerId };
      }

      const tickerId = args.tickerId || Math.floor(Math.random() * 10000);
      const contract: Contract = {
        symbol: args.symbol,
        secType: args.secType === 'IND' ? SecType.IND : SecType.STK,
        exchange: 'SMART',
        currency: 'USD'
      };

      const updates: any[] = [];
      
      return new Promise((resolve) => {
        api.on(EventName.tickPrice, (id: number, tickType: TickType, price: number) => {
          if (id === tickerId) {
            updates.push({
              type: 'price',
              tickType: TickType[tickType],
              value: price,
              timestamp: new Date().toISOString()
            });
          }
        });

        api.on(EventName.tickSize, (id: number, tickType: TickType, size: bigint) => {
          if (id === tickerId) {
            updates.push({
              type: 'size',
              tickType: TickType[tickType],
              value: Number(size),
              timestamp: new Date().toISOString()
            });
          }
        });

        api.reqMktData(tickerId, contract, '', false, false);

        // Return initial response after 1 second
        setTimeout(() => {
          resolve({
            message: 'Subscribed to market data',
            symbol: args.symbol,
            tickerId,
            initialUpdates: updates,
            note: 'Continue to receive updates via tickPrice and tickSize events'
          });
        }, 1000);
      });
    }
  }
};