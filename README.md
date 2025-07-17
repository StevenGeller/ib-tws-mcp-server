# Interactive Brokers TWS MCP Server

An MCP (Model Context Protocol) server that provides integration with Interactive Brokers TWS (Trader Workstation) API for trading operations, market data, and portfolio management.

## Features

### Portfolio Management
- **getPositions**: Retrieve all portfolio positions
- **getAccountSummary**: Get account balance, buying power, P&L, and other metrics
- **getPortfolioUpdates**: Subscribe to real-time portfolio updates

### Options Trading
- **getOptionChain**: Get option chains for a given underlying symbol
- **getOptionDetails**: Get detailed option contract information  
- **getPositions**: Get portfolio positions with comprehensive option details including strike prices, expiration dates, and Greeks
- **getPositionDetails**: Get detailed information for specific positions including real-time Greeks
- **getPortfolioGreeks**: Calculate aggregate Greeks for entire portfolio or by underlying symbol
- **Enhanced Option Support**: All option positions now include strike prices, expiration dates, option type (calls vs puts), and real-time Greeks (delta, gamma, vega, theta)

### Market Data
- **getQuote**: Get real-time quotes for stocks and indices
- **getHistoricalData**: Retrieve historical price data with various bar sizes
- **streamMarketData**: Subscribe to real-time streaming market data

### Order Management
- **placeOrder**: Place orders for stocks and options (Market, Limit, Stop, Stop-Limit)
- **cancelOrder**: Cancel open orders
- **getOpenOrders**: View all open orders
- **modifyOrder**: Modify existing orders (quantity, price)

## Prerequisites

1. **Interactive Brokers Account**: You need an IB account (paper trading account recommended for testing)
2. **TWS or IB Gateway**: Install and run either:
   - TWS (Trader Workstation): Full trading platform
   - IB Gateway: Lightweight connection interface
3. **API Configuration**: Enable API connections in TWS/Gateway:
   - Go to File → Global Configuration → API → Settings
   - Enable "Enable ActiveX and Socket Clients"
   - Set "Socket port" (default: 7497 for paper, 7496 for live)
   - Add "127.0.0.1" to "Trusted IP Addresses"

## Installation

```bash
cd ib-tws-mcp-server
npm install
npm run build
```

## Configuration

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\\Claude\\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ib-tws": {
      "command": "node",
      "args": ["/path/to/ib-tws-mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

## Usage

### 1. Connect to TWS

First, ensure TWS or IB Gateway is running, then connect:

```javascript
// Connect to paper trading (port 7497)
connect({
  host: "127.0.0.1",
  port: 7497,
  clientId: 0
})

// Connect to live trading (port 7496) - use with caution!
connect({
  host: "127.0.0.1", 
  port: 7496,
  clientId: 0
})
```

### 2. Portfolio Operations

```javascript
// Get all positions
getPositions()

// Get account summary
getAccountSummary({
  tags: ["NetLiquidation", "BuyingPower", "UnrealizedPnL"]
})

// Subscribe to portfolio updates
getPortfolioUpdates({
  account: "DU1234567",
  subscribe: true
})
```

### 3. Market Data

```javascript
// Get real-time quote
getQuote({
  symbol: "AAPL",
  secType: "STK"
})

// Get S&P 500 index quote
getQuote({
  symbol: "SPX",
  secType: "IND"
})

// Get historical data
getHistoricalData({
  symbol: "AAPL",
  duration: "1 D",
  barSize: "5 mins",
  whatToShow: "TRADES"
})
```

### 4. Options Trading

```javascript
// Get option chain
getOptionChain({
  symbol: "AAPL",
  expiration: "20240119" // Optional: specific expiration
})

// Get portfolio Greeks aggregated by underlying
getPortfolioGreeks({
  byUnderlying: true
})

// Get detailed position information with Greeks
getPositionDetails({
  symbol: "AAPL"
})

// Get positions with full option details
getPositions({
  includeGreeks: true,
  groupByUnderlying: true
})
```

### 5. Order Management

```javascript
// Place a market order
placeOrder({
  symbol: "AAPL",
  action: "BUY",
  quantity: 100,
  orderType: "MKT"
})

// Place a limit order
placeOrder({
  symbol: "AAPL",
  action: "BUY",
  quantity: 100,
  orderType: "LMT",
  limitPrice: 150.50
})

// Place an option order
placeOrder({
  symbol: "AAPL",
  secType: "OPT",
  action: "BUY",
  quantity: 1,
  orderType: "LMT",
  limitPrice: 5.50,
  expiration: "20240119",
  strike: 150,
  right: "C"
})

// Get open orders
getOpenOrders()

// Cancel an order
cancelOrder({
  orderId: 12345
})
```

## Important Notes

1. **Paper Trading**: Always test with a paper trading account first (port 7497)
2. **Rate Limits**: TWS has a 50 messages/second limit for all API connections
3. **Market Hours**: Some features only work during market hours
4. **Data Subscriptions**: Real-time market data requires appropriate IB data subscriptions
5. **Order IDs**: The server generates random order IDs. In production, implement proper ID management

## Troubleshooting

### Connection Issues
- Ensure TWS/Gateway is running and API is enabled
- Check the port number (7497 for paper, 7496 for live)
- Verify "127.0.0.1" is in trusted IP addresses
- Try increasing the connection timeout in TWS settings

### Market Data Issues
- Verify you have appropriate market data subscriptions
- Some data is only available during market hours
- Check if you've exceeded concurrent market data lines limit

### Order Issues
- Ensure sufficient buying power for orders
- Check if the market is open for the security type
- Verify option contract specifications are correct

## Security

- Never share your TWS credentials or API configuration
- Use paper trading accounts for testing
- Implement proper error handling in production
- Consider implementing additional authentication layers

## Disclaimer

**IMPORTANT NOTICE: This software is provided for educational and testing purposes only.**

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

**TRADING DISCLAIMER**: Trading securities, options, futures and forex involves substantial risk of loss and is not suitable for every investor. The valuation of securities, options, futures and forex may fluctuate, and, as a result, clients may lose more than their original investment. The impact of seasonal and geopolitical events is already factored into market prices. The highly leveraged nature of futures trading means that small market movements will have a great impact on your trading account and this can work against you, leading to large losses or can work for you, leading to large gains.

**NO INVESTMENT ADVICE**: This software does not provide investment advice. All content is for informational purposes only and should not be construed as investment advice or a recommendation to buy or sell any security or investment. You should consult with a qualified financial advisor before making any investment decisions.

**USE AT YOUR OWN RISK**: 
- This software interfaces with live trading systems and can place real orders that result in financial losses
- The authors assume no responsibility for any losses incurred through the use of this software
- You are solely responsible for any trades placed using this software
- Always test thoroughly with paper trading accounts before using with real money
- Monitor all automated trading activity carefully

**NO LIABILITY**: Under no circumstances shall the authors, contributors, or copyright holders be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.

**COMPLIANCE**: You are responsible for complying with all applicable laws and regulations in your jurisdiction, including but not limited to securities laws and regulations. This software is not endorsed by or affiliated with Interactive Brokers Group, Inc.

By using this software, you acknowledge that you have read this disclaimer and agree to its terms.

## License

**Public Domain / Unlicense**

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute this software, either in source code form or as a compiled binary, for any purpose, commercial or non-commercial, and by any means.

In jurisdictions that recognize copyright laws, the author or authors of this software dedicate any and all copyright interest in the software to the public domain. We make this dedication for the benefit of the public at large and to the detriment of our heirs and successors. We intend this dedication to be an overt act of relinquishment in perpetuity of all present and future rights to this software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org/>