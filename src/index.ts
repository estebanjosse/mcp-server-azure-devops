#!/usr/bin/env node
/**
 * Entry point for the Azure DevOps MCP Server
 */

import { createAzureDevOpsServer } from './server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as http from 'http';
import dotenv from 'dotenv';
import { AzureDevOpsConfig } from './shared/types';
import { AuthenticationMethod } from './shared/auth/auth-factory';

/**
 * Normalize auth method string to a valid AuthenticationMethod enum value
 * in a case-insensitive manner
 *
 * @param authMethodStr The auth method string from environment variable
 * @returns A valid AuthenticationMethod value
 */
export function normalizeAuthMethod(
  authMethodStr?: string,
): AuthenticationMethod {
  if (!authMethodStr) {
    return AuthenticationMethod.AzureIdentity; // Default
  }

  // Convert to lowercase for case-insensitive comparison
  const normalizedMethod = authMethodStr.toLowerCase();

  // Check against known enum values (as lowercase strings)
  if (
    normalizedMethod === AuthenticationMethod.PersonalAccessToken.toLowerCase()
  ) {
    return AuthenticationMethod.PersonalAccessToken;
  } else if (
    normalizedMethod === AuthenticationMethod.AzureIdentity.toLowerCase()
  ) {
    return AuthenticationMethod.AzureIdentity;
  } else if (normalizedMethod === AuthenticationMethod.AzureCli.toLowerCase()) {
    return AuthenticationMethod.AzureCli;
  }

  // If not recognized, log a warning and use the default
  process.stderr.write(
    `WARNING: Unrecognized auth method '${authMethodStr}'. Using default (${AuthenticationMethod.AzureIdentity}).\n`,
  );
  return AuthenticationMethod.AzureIdentity;
}

/** Transport modes supported by the server. */
export type TransportMode = 'stdio' | 'http';

/** Hosts that are considered local and therefore trigger DNS-rebinding protection. */
const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Normalize the transport mode from the MCP_TRANSPORT environment variable.
 *
 * @param transportStr The raw value from the environment variable
 * @returns A valid TransportMode value ('stdio' by default)
 */
export function normalizeTransport(transportStr?: string): TransportMode {
  if (!transportStr) {
    return 'stdio';
  }

  const normalized = transportStr.toLowerCase().trim();

  if (normalized === 'http') {
    return 'http';
  }

  if (normalized === 'stdio') {
    return 'stdio';
  }

  process.stderr.write(
    `WARNING: Unrecognized transport '${transportStr}'. Using default (stdio).\n`,
  );
  return 'stdio';
}

// Load environment variables
dotenv.config();

function getConfig(): AzureDevOpsConfig {
  // Debug log the environment variables to help diagnose issues
  process.stderr.write(`DEBUG - Environment variables in getConfig():
  AZURE_DEVOPS_ORG_URL: ${process.env.AZURE_DEVOPS_ORG_URL || 'NOT SET'}
  AZURE_DEVOPS_AUTH_METHOD: ${process.env.AZURE_DEVOPS_AUTH_METHOD || 'NOT SET'}
  AZURE_DEVOPS_PAT: ${process.env.AZURE_DEVOPS_PAT ? 'SET (hidden)' : 'NOT SET'}
  AZURE_DEVOPS_DEFAULT_PROJECT: ${process.env.AZURE_DEVOPS_DEFAULT_PROJECT || 'NOT SET'}
  AZURE_DEVOPS_API_VERSION: ${process.env.AZURE_DEVOPS_API_VERSION || 'NOT SET'}
  NODE_ENV: ${process.env.NODE_ENV || 'NOT SET'}
\n`);

  return {
    organizationUrl: process.env.AZURE_DEVOPS_ORG_URL || '',
    authMethod: normalizeAuthMethod(process.env.AZURE_DEVOPS_AUTH_METHOD),
    personalAccessToken: process.env.AZURE_DEVOPS_PAT,
    defaultProject: process.env.AZURE_DEVOPS_DEFAULT_PROJECT,
    apiVersion: process.env.AZURE_DEVOPS_API_VERSION,
  };
}

async function main() {
  try {
    // Create the server with configuration
    const server = createAzureDevOpsServer(getConfig());

    const transportMode = normalizeTransport(process.env.MCP_TRANSPORT);

    if (transportMode === 'http') {
      await startHttpTransport(server);
    } else {
      // Default: stdio transport
      const transport = new StdioServerTransport();
      await server.connect(transport);
      process.stderr.write('Azure DevOps MCP Server running on stdio\n');
    }
  } catch (error) {
    process.stderr.write(`Error starting server: ${error}\n`);
    process.exit(1);
  }
}

/**
 * Start the server with a Streamable HTTP transport.
 *
 * Binds to MCP_HTTP_HOST (default: 127.0.0.1) and MCP_HTTP_PORT (default: 3000).
 * DNS-rebinding protection is applied automatically when binding to a localhost address.
 *
 * @param server The MCP server instance to connect
 */
async function startHttpTransport(
  server: ReturnType<typeof createAzureDevOpsServer>,
): Promise<void> {
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
  const port = parseInt(process.env.MCP_HTTP_PORT || '3000', 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid MCP_HTTP_PORT value '${process.env.MCP_HTTP_PORT}'. Must be a number between 1 and 65535.`,
    );
  }

  const isLocalhost = LOCALHOST_HOSTS.has(host);

  // Stateless transport: each request is handled independently.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  const httpServer = http.createServer(async (req, res) => {
    // DNS-rebinding protection: for localhost bindings, reject requests whose
    // Host header does not match the expected host:port.
    if (isLocalhost) {
      const requestHost = req.headers['host'];
      if (!isAllowedHost(requestHost, host, port)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: invalid Host header\n');
        return;
      }
    }

    await transport.handleRequest(req, res);
  });

  // Guard against slow/idle connections to prevent resource exhaustion.
  httpServer.requestTimeout = 30_000; // 30 s per request
  httpServer.setTimeout(60_000); // 60 s idle socket timeout

  await server.connect(transport);

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      process.stderr.write(
        `Azure DevOps MCP Server running on http://${host}:${port}\n`,
      );
      resolve();
    });
  });

  // Keep the process alive until interrupted.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      httpServer.close();
      resolve();
    });
    process.on('SIGTERM', () => {
      httpServer.close();
      resolve();
    });
  });
}

/**
 * Determine whether an incoming Host header is allowed under DNS-rebinding protection.
 *
 * Allowed values are:
 *  - `<host>:<port>` (exact match)
 *  - `<host>` without a port only when port is the HTTP default port 80
 *  - Any localhost alias (`localhost`, `127.0.0.1`, `::1`) with the correct port
 *    when the server is bound to a localhost address
 *
 * @param headerValue The raw value of the incoming Host header
 * @param boundHost The host the server is bound to
 * @param boundPort The port the server is bound to
 */
export function isAllowedHost(
  headerValue: string | undefined,
  boundHost: string,
  boundPort: number,
): boolean {
  if (!headerValue) {
    return false;
  }

  // Accepted forms: "host:port" or just "host" (when port is implicit)
  const allowed = new Set<string>([
    `${boundHost}:${boundPort}`,
    // Allow all localhost aliases with the correct port
    ...(LOCALHOST_HOSTS.has(boundHost)
      ? [...LOCALHOST_HOSTS].map((h) => `${h}:${boundPort}`)
      : []),
  ]);

  // Allow bare hostname (without port) only for the default HTTP port 80.
  // Port 443 is intentionally excluded: this server uses plain HTTP, not HTTPS.
  if (boundPort === 80) {
    allowed.add(boundHost);
    if (LOCALHOST_HOSTS.has(boundHost)) {
      LOCALHOST_HOSTS.forEach((h) => allowed.add(h));
    }
  }

  return allowed.has(headerValue);
}

// Start the server when this script is run directly
if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Fatal error in main(): ${error}\n`);
    process.exit(1);
  });
}

// Export the server and related components
export * from './server';
