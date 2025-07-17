import { EventName, Contract, Order, OrderAction, OrderType, TimeInForce, SecType } from '@stoqey/ib';
import { z } from 'zod';
import { TWSConnection } from '../connection.js';

export const OrderTools = {
  placeOrder: {
    name: 'placeOrder',
    description: 'Place a new order for stocks or options',
    inputSchema: z.object({
      symbol: z.string().describe('Symbol'),
      secType: z.enum(['STK', 'OPT']).default('STK').describe('Security type'),
      action: z.enum(['BUY', 'SELL']).describe('Order action'),
      quantity: z.number().describe('Number of shares/contracts'),
      orderType: z.enum(['MKT', 'LMT', 'STP', 'STP_LMT']).describe('Order type'),
      limitPrice: z.number().optional().describe('Limit price (required for LMT and STP_LMT)'),
      stopPrice: z.number().optional().describe('Stop price (required for STP and STP_LMT)'),
      tif: z.enum(['DAY', 'GTC', 'IOC', 'GTD']).default('DAY').describe('Time in force'),
      account: z.string().optional().describe('Account ID'),
      // Option-specific fields
      expiration: z.string().optional().describe('Option expiration (YYYYMMDD)'),
      strike: z.number().optional().describe('Option strike price'),
      right: z.enum(['C', 'P']).optional().describe('Option type: C for Call, P for Put')
    }),
    execute: async (connection: TWSConnection, args: any) => {
      const api = connection.getApi();
      const orderId = Math.floor(Math.random() * 100000);

      let contract: Contract;
      
      if (args.secType === 'OPT') {
        contract = {
          symbol: args.symbol,
          secType: SecType.OPT,
          exchange: 'SMART',
          currency: 'USD',
          lastTradeDateOrContractMonth: args.expiration,
          strike: args.strike,
          right: args.right
        };
      } else {
        contract = {
          symbol: args.symbol,
          secType: SecType.STK,
          exchange: 'SMART',
          currency: 'USD'
        };
      }

      const orderTypeMap: Record<string, OrderType> = {
        'MKT': OrderType.MKT,
        'LMT': OrderType.LMT,
        'STP': OrderType.STP,
        'STP_LMT': OrderType.STP_LMT
      };

      const tifMap: Record<string, TimeInForce> = {
        'DAY': TimeInForce.DAY,
        'GTC': TimeInForce.GTC,
        'IOC': TimeInForce.IOC,
        'GTD': TimeInForce.GTD
      };

      const order: Order = {
        orderId,
        action: args.action === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
        totalQuantity: args.quantity,
        orderType: orderTypeMap[args.orderType],
        lmtPrice: args.limitPrice,
        auxPrice: args.stopPrice,
        tif: tifMap[args.tif],
        account: args.account
      };

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.openOrder);
          api.removeAllListeners(EventName.orderStatus);
          reject(new Error('Timeout waiting for order confirmation'));
        }, 10000);

        let orderDetails: any = null;
        let orderStatus: any = null;

        api.on(EventName.openOrder, (orderId: number, contract: Contract, order: Order, orderState: any) => {
          if (orderId === order.orderId) {
            orderDetails = {
              orderId,
              contract,
              order,
              orderState
            };
          }
        });

        api.on(EventName.orderStatus, (orderId: number, status: string, filled: number, remaining: number, 
          avgFillPrice: number, permId: number, parentId: number, lastFillPrice: number, clientId: number, 
          whyHeld: string, mktCapPrice: number) => {
          if (orderId === order.orderId) {
            orderStatus = {
              orderId,
              status,
              filled,
              remaining,
              avgFillPrice,
              permId,
              lastFillPrice
            };
            
            clearTimeout(timeout);
            api.removeAllListeners(EventName.openOrder);
            api.removeAllListeners(EventName.orderStatus);
            
            resolve({
              orderId,
              symbol: args.symbol,
              action: args.action,
              quantity: args.quantity,
              orderType: args.orderType,
              status: orderStatus,
              details: orderDetails
            });
          }
        });

        api.placeOrder(orderId, contract, order);
      });
    }
  },

  cancelOrder: {
    name: 'cancelOrder',
    description: 'Cancel an open order',
    inputSchema: z.object({
      orderId: z.number().describe('Order ID to cancel')
    }),
    execute: async (connection: TWSConnection, args: { orderId: number }) => {
      const api = connection.getApi();
      
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.orderStatus);
          resolve({ orderId: args.orderId, status: 'Cancel request sent' });
        }, 5000);

        api.on(EventName.orderStatus, (orderId: number, status: string) => {
          if (orderId === args.orderId && status === 'Cancelled') {
            clearTimeout(timeout);
            api.removeAllListeners(EventName.orderStatus);
            resolve({
              orderId: args.orderId,
              status: 'Cancelled',
              message: 'Order successfully cancelled'
            });
          }
        });

        api.cancelOrder(args.orderId, '');
      });
    }
  },

  getOpenOrders: {
    name: 'getOpenOrders',
    description: 'Get all open orders',
    inputSchema: z.object({
      account: z.string().optional().describe('Filter by account (optional)')
    }),
    execute: async (connection: TWSConnection, args: { account?: string }) => {
      const api = connection.getApi();
      const orders: any[] = [];

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          api.removeAllListeners(EventName.openOrder);
          api.removeAllListeners(EventName.openOrderEnd);
          resolve({ orders, count: orders.length });
        }, 10000);

        api.on(EventName.openOrder, (orderId: number, contract: Contract, order: Order, orderState: any) => {
          if (!args.account || order.account === args.account) {
            orders.push({
              orderId,
              symbol: contract.symbol,
              secType: contract.secType,
              action: order.action,
              orderType: order.orderType,
              quantity: order.totalQuantity,
              limitPrice: order.lmtPrice,
              stopPrice: order.auxPrice,
              status: orderState.status,
              account: order.account
            });
          }
        });

        api.on(EventName.openOrderEnd, () => {
          clearTimeout(timeout);
          api.removeAllListeners(EventName.openOrder);
          api.removeAllListeners(EventName.openOrderEnd);
          resolve({ orders, count: orders.length });
        });

        api.reqOpenOrders();
      });
    }
  },

  modifyOrder: {
    name: 'modifyOrder',
    description: 'Modify an existing order',
    inputSchema: z.object({
      orderId: z.number().describe('Order ID to modify'),
      quantity: z.number().optional().describe('New quantity'),
      limitPrice: z.number().optional().describe('New limit price'),
      stopPrice: z.number().optional().describe('New stop price')
    }),
    execute: async (connection: TWSConnection, args: any) => {
      const api = connection.getApi();

      return new Promise((resolve, reject) => {
        let existingOrder: any = null;
        let existingContract: any = null;

        const findTimeout = setTimeout(() => {
          api.removeAllListeners(EventName.openOrder);
          reject(new Error('Order not found'));
        }, 5000);

        api.on(EventName.openOrder, (orderId: number, contract: Contract, order: Order, orderState: any) => {
          if (orderId === args.orderId) {
            clearTimeout(findTimeout);
            api.removeAllListeners(EventName.openOrder);
            
            existingOrder = order;
            existingContract = contract;

            // Modify the order with new values
            if (args.quantity !== undefined) existingOrder.totalQuantity = args.quantity;
            if (args.limitPrice !== undefined) existingOrder.lmtPrice = args.limitPrice;
            if (args.stopPrice !== undefined) existingOrder.auxPrice = args.stopPrice;

            // Place the modified order
            const modifyTimeout = setTimeout(() => {
              api.removeAllListeners(EventName.orderStatus);
              resolve({
                orderId: args.orderId,
                status: 'Modification request sent',
                newQuantity: existingOrder.totalQuantity,
                newLimitPrice: existingOrder.lmtPrice,
                newStopPrice: existingOrder.auxPrice
              });
            }, 5000);

            api.on(EventName.orderStatus, (orderId: number, status: string) => {
              if (orderId === args.orderId) {
                clearTimeout(modifyTimeout);
                api.removeAllListeners(EventName.orderStatus);
                resolve({
                  orderId: args.orderId,
                  status,
                  message: 'Order successfully modified',
                  newQuantity: existingOrder.totalQuantity,
                  newLimitPrice: existingOrder.lmtPrice,
                  newStopPrice: existingOrder.auxPrice
                });
              }
            });

            api.placeOrder(args.orderId, existingContract, existingOrder);
          }
        });

        api.reqOpenOrders();
      });
    }
  }
};