#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { TWSConnection, ConnectionConfigSchema } from './connection.js';
import { PortfolioTools } from './tools/portfolio.js';
import { OptionsTools } from './tools/options.js';
import { MarketDataTools } from './tools/marketdata.js';
import { OrderTools } from './tools/orders.js';

// Combine all tools
const ALL_TOOLS = {
  ...PortfolioTools,
  ...OptionsTools,
  ...MarketDataTools,
  ...OrderTools
};

// Server configuration
const serverInfo = {
  name: 'ib-tws-mcp-server',
  version: '1.0.0',
  description: 'MCP server for Interactive Brokers TWS API integration'
};

// Connection instance
let connection: TWSConnection | null = null;

// Initialize MCP server
const server = new Server(serverInfo, {
  capabilities: {
    tools: {}
  }
});

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.entries(ALL_TOOLS).map(([name, tool]) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Special case: connect tool
  if (name === 'connect') {
    try {
      const config = ConnectionConfigSchema.parse(args);
      if (connection) {
        await connection.disconnect();
      }
      connection = new TWSConnection(config);
      await connection.connect();
      return {
        content: [
          {
            type: 'text',
            text: `Connected to TWS at ${config.host}:${config.port}`
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to connect: ${error}`
      );
    }
  }

  // Special case: disconnect tool
  if (name === 'disconnect') {
    if (connection) {
      await connection.disconnect();
      connection = null;
      return {
        content: [
          {
            type: 'text',
            text: 'Disconnected from TWS'
          }
        ]
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to TWS'
          }
        ]
      };
    }
  }

  // Check if connected for other tools
  if (!connection || !connection.isConnected()) {
    throw new McpError(
      ErrorCode.InternalError,
      'Not connected to TWS. Please connect first using the "connect" tool.'
    );
  }

  // Find and execute tool
  const tool = ALL_TOOLS[name as keyof typeof ALL_TOOLS];
  if (!tool) {
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Tool not found: ${name}`
    );
  }

  try {
    const result = await tool.execute(connection, args || {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Tool execution failed: ${error}`
    );
  }
});

// Add connection management tools
const connectionTools = {
  connect: {
    name: 'connect',
    description: 'Connect to TWS/IB Gateway',
    inputSchema: ConnectionConfigSchema,
    execute: async () => {} // Handled above
  },
  disconnect: {
    name: 'disconnect',
    description: 'Disconnect from TWS/IB Gateway',
    inputSchema: z.object({}),
    execute: async () => {} // Handled above
  }
};

// Add connection tools to ALL_TOOLS for listing
Object.assign(ALL_TOOLS, connectionTools);

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (connection) {
    await connection.disconnect();
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