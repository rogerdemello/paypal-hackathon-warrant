#!/usr/bin/env -S npx tsx
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WarrantApi } from './api';
import { createWarrantMcpServer } from './tools';

/**
 * The Warrant MCP server over stdio. Point an MCP client at it, for example in Claude Code:
 *
 *   claude mcp add warrant -- pnpm --silent --filter @warrant/mcp start
 *
 * Environment:
 *   WARRANT_API_URL         the Warrant server (default http://localhost:8787)
 *   WARRANT_CONSOLE_TOKEN   its console token, only needed when the server is not in judge mode
 *
 * stdout carries the protocol, so anything meant for a person goes to stderr.
 */

const baseUrl = process.env['WARRANT_API_URL']?.trim() || 'http://localhost:8787';
const api = new WarrantApi({ baseUrl, consoleToken: process.env['WARRANT_CONSOLE_TOKEN']?.trim() || null });
const server = createWarrantMcpServer(api);
await server.connect(new StdioServerTransport());
process.stderr.write(`Warrant MCP server ready (tools: verify_warrant, get_dispute_facts; API ${baseUrl})\n`);
