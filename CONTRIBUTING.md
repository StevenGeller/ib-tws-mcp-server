# Contributing to IB TWS MCP Server

Thank you for your interest in contributing to the Interactive Brokers TWS MCP Server! This document provides guidelines for contributing to the project.

## How to Contribute

### Reporting Issues

- Use the GitHub issue tracker to report bugs
- Describe the issue clearly, including steps to reproduce
- Include your environment details (OS, Node.js version, TWS version)

### Submitting Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Code Style

- Use TypeScript for all new code
- Follow the existing code style
- Add appropriate type definitions
- Include comments for complex logic
- Run the linter before submitting

### Testing

- Test your changes with both paper trading and live accounts (carefully!)
- Ensure all existing functionality still works
- Add tests for new features when possible

### Commit Messages

- Use clear and descriptive commit messages
- Start with a verb in present tense (e.g., "Add", "Fix", "Update")
- Reference issue numbers when applicable

## Development Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Build the project: `npm run build`
4. Test with Claude Desktop

## Safety Guidelines

- **Never commit API credentials or account information**
- Always test with paper trading accounts first
- Be extremely careful with order placement functionality
- Include appropriate warnings in documentation

## Questions?

Feel free to open an issue for any questions about contributing.

Thank you for helping make this project better!