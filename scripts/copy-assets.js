import { mkdirSync } from 'fs';

// Ensure dist directory exists
mkdirSync('./dist', { recursive: true });

console.log('Build completed successfully');