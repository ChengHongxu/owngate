// MCP (Streamable HTTP) entry point
// Design doc §9.1: Streamable HTTP + Bearer token, no OAuth
import type { FastifyInstance } from 'fastify';
import type { InvokeServices, InvokeOptions } from '@webridge/core';
import { invoke } from '@webridge/core';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

interface McpDeps {
  services: InvokeServices;
  invokeOpts: InvokeOptions;
}

export async function registerMcpRoutes(app: FastifyInstance, deps: McpDeps) {
  app.post('/mcp', async (request, reply) => {
    const token = extractToken(request.headers['authorization'] as string | undefined);
    if (!token) {
      return reply.status(401).send({ error: 'Missing Authorization header' });
    }

    const server = new McpServer({
      name: 'webridge',
      version: '0.1.0',
    });

    // ── Generic query tool ────────────────────────────────────────────────
    server.tool(
      'query',
      'Invoke a query capability on a connection',
      {
        connection_id: z.string().describe('The connection ID to query'),
        capability_id: z.string().describe('The capability to invoke'),
        input: z.record(z.unknown()).optional().describe('Input parameters'),
        no_cache: z.boolean().optional().describe('Skip cache'),
      },
      async (params) => {
        const envelope = await invoke(
          {
            token,
            connection_id: params.connection_id,
            capability_id: params.capability_id,
            input: params.input ?? {},
            ...(params.no_cache !== undefined ? { no_cache: params.no_cache } : {}),
          },
          deps.services,
          deps.invokeOpts,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
          isError: envelope.outcome === 'error',
        };
      },
    );

    // ── list_connections tool ─────────────────────────────────────────────
    server.tool(
      'list_connections',
      'List all available connections',
      {},
      async () => {
        // Return connection IDs accessible to this client
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const client = deps.services.auth.getClient(tokenHash);
        if (!client) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'UNAUTHORIZED' }) }], isError: true };
        }
        const grants = deps.services.auth.getGrants(client.id);
        const connectionIds = grants.map(g => g.connection_id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ connections: connectionIds }) }],
        };
      },
    );

    const transport = new StreamableHTTPServerTransport({});

    await server.connect(transport);
    await transport.handleRequest(
      request.raw,
      reply.raw,
      request.body,
    );
  });

  // GET /mcp for SSE (optional, for clients that use SSE transport)
  app.get('/mcp', async (_request, reply) => {
    return reply.status(405).send({ error: 'Use POST for MCP Streamable HTTP' });
  });
}

function extractToken(auth: string | undefined): string | null {
  if (!auth) return null;
  const [scheme, token] = auth.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}
