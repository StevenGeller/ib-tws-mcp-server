import { EventName, Contract, SecType } from '@stoqey/ib';
import { z } from 'zod';
import { TWSConnection } from '../connection.js';

export const OptionsTools = {
  getOptionChain: {
    name: 'getOptionChain',
    description: 'Get option chain for a given underlying symbol',
    inputSchema: z.object({
      symbol: z.string().describe('Underlying symbol (e.g., AAPL)'),
      exchange: z.string().default('SMART').describe('Exchange (default: SMART)'),
      expiration: z.string().optional().describe('Specific expiration date (YYYYMMDD format)')
    }),
    execute: async (connection: TWSConnection, args: { symbol: string; exchange?: string; expiration?: string }) => {
      const api = connection.getApi();
      const reqId = Math.floor(Math.random() * 10000);

      // First, get contract details for the underlying
      const underlyingContract: Contract = {
        symbol: args.symbol,
        secType: SecType.STK,
        exchange: args.exchange || 'SMART',
        currency: 'USD'
      };

      return new Promise((resolve, reject) => {
        const optionChains: any[] = [];
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.securityDefinitionOptionParameter);
          api.removeAllListeners(EventName.securityDefinitionOptionParameterEnd);
          reject(new Error('Timeout waiting for option chains'));
        }, 15000);

        api.on(EventName.securityDefinitionOptionParameter, (
          reqId: number,
          exchange: string,
          underlyingConId: number,
          tradingClass: string,
          multiplier: string,
          expirations: string[],
          strikes: number[]
        ) => {
          const filteredExpirations = args.expiration 
            ? expirations.filter(exp => exp === args.expiration)
            : expirations;

          optionChains.push({
            exchange,
            underlyingConId,
            tradingClass,
            multiplier,
            expirations: filteredExpirations,
            strikes,
            symbol: args.symbol
          });
        });

        api.on(EventName.securityDefinitionOptionParameterEnd, (reqId: number) => {
          clearTimeout(timeout);
          api.removeAllListeners(EventName.securityDefinitionOptionParameter);
          api.removeAllListeners(EventName.securityDefinitionOptionParameterEnd);
          resolve({
            symbol: args.symbol,
            chains: optionChains,
            count: optionChains.length
          });
        });

        api.reqSecDefOptParams(reqId, args.symbol, '', 'STK', underlyingContract.conId || 0);
      });
    }
  },

  getOptionDetails: {
    name: 'getOptionDetails',
    description: 'Get detailed option contract information including Greeks',
    inputSchema: z.object({
      symbol: z.string().describe('Underlying symbol'),
      expiration: z.string().describe('Expiration date (YYYYMMDD)'),
      strike: z.number().describe('Strike price'),
      right: z.enum(['C', 'P']).describe('Option type: C for Call, P for Put'),
      exchange: z.string().default('SMART').describe('Exchange (default: SMART)')
    }),
    execute: async (connection: TWSConnection, args: any) => {
      const api = connection.getApi();
      const reqId = Math.floor(Math.random() * 10000);

      const optionContract: Contract = {
        symbol: args.symbol,
        secType: SecType.OPT,
        exchange: args.exchange || 'SMART',
        currency: 'USD',
        lastTradeDateOrContractMonth: args.expiration,
        strike: args.strike,
        right: args.right
      };

      return new Promise((resolve, reject) => {
        const contractDetails: any[] = [];
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.contractDetails);
          api.removeAllListeners(EventName.contractDetailsEnd);
          reject(new Error('Timeout waiting for contract details'));
        }, 10000);

        api.on(EventName.contractDetails, (reqId: number, contractDetails: any) => {
          contractDetails.push(contractDetails);
        });

        api.on(EventName.contractDetailsEnd, (reqId: number) => {
          clearTimeout(timeout);
          api.removeAllListeners(EventName.contractDetails);
          api.removeAllListeners(EventName.contractDetailsEnd);
          
          if (contractDetails.length > 0) {
            resolve({
              contract: optionContract,
              details: contractDetails[0],
              count: contractDetails.length
            });
          } else {
            reject(new Error('No contract details found'));
          }
        });

        api.reqContractDetails(reqId, optionContract);
      });
    }
  },

  getOptionGreeks: {
    name: 'getOptionGreeks',
    description: 'Calculate option Greeks (Delta, Gamma, Vega, Theta) for a specific option',
    inputSchema: z.object({
      symbol: z.string().describe('Underlying symbol'),
      expiration: z.string().describe('Expiration date (YYYYMMDD)'),
      strike: z.number().describe('Strike price'),
      right: z.enum(['C', 'P']).describe('Option type: C for Call, P for Put'),
      underlyingPrice: z.number().optional().describe('Current underlying price (optional)'),
      volatility: z.number().optional().describe('Implied volatility (optional)')
    }),
    execute: async (connection: TWSConnection, args: any) => {
      const api = connection.getApi();
      const tickerId = Math.floor(Math.random() * 10000);

      const optionContract: Contract = {
        symbol: args.symbol,
        secType: SecType.OPT,
        exchange: 'SMART',
        currency: 'USD',
        lastTradeDateOrContractMonth: args.expiration,
        strike: args.strike,
        right: args.right
      };

      return new Promise((resolve, reject) => {
        const greeks: any = {
          symbol: args.symbol,
          expiration: args.expiration,
          strike: args.strike,
          right: args.right
        };
        
        let dataReceived = 0;
        const requiredData = 5; // Wait for multiple tick types
        
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.tickOptionComputation);
          api.cancelMktData(tickerId);
          if (dataReceived > 0) {
            resolve(greeks);
          } else {
            reject(new Error('Timeout waiting for Greeks data'));
          }
        }, 10000);

        api.on(EventName.tickOptionComputation, (
          tickerId: number,
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
          if (delta !== -1) greeks.delta = delta;
          if (gamma !== -1) greeks.gamma = gamma;
          if (vega !== -1) greeks.vega = vega;
          if (theta !== -1) greeks.theta = theta;
          if (impliedVol !== -1) greeks.impliedVolatility = impliedVol;
          if (undPrice !== -1) greeks.underlyingPrice = undPrice;
          if (optPrice !== -1) greeks.optionPrice = optPrice;
          
          dataReceived++;
          
          if (dataReceived >= requiredData) {
            clearTimeout(timeout);
            api.removeAllListeners(EventName.tickOptionComputation);
            api.cancelMktData(tickerId);
            resolve(greeks);
          }
        });

        // Request market data including Greeks
        api.reqMktData(tickerId, optionContract, '', false, false);
      });
    }
  }
};