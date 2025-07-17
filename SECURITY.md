# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.2.x   | :white_check_mark: |
| < 1.2   | :x:                |

## Reporting a Vulnerability

**IMPORTANT**: This software interfaces with financial trading systems. Security is critical.

If you discover a security vulnerability, please:

1. **DO NOT** open a public issue
2. Email the details to the repository owner through GitHub
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Security Considerations

### API Credentials
- Never store TWS credentials in code
- Use environment variables for sensitive configuration
- Keep your TWS API settings secure

### Trading Safety
- Always test with paper trading accounts first
- Implement your own risk management logic
- Use the built-in safety limits (MAX_ORDER_QUANTITY, etc.)
- Monitor rate limits to avoid API bans

### Connection Security
- This tool connects to TWS locally (127.0.0.1)
- TWS API does not support TLS/SSL encryption
- Ensure your local machine is secure
- Use firewall rules to restrict TWS API access

### Best Practices
- Regularly update dependencies
- Review code changes carefully
- Enable TWS read-only API access when not trading
- Use separate API client IDs for different applications
- Enable TWS auto-logoff timers

## Disclaimer

This software is provided as-is. Users are responsible for:
- Their own trading decisions
- Securing their TWS installation
- Implementing appropriate risk controls
- Complying with all applicable regulations