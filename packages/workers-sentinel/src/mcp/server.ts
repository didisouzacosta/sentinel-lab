/**
 * The Sentinel MCP server: Streamable HTTP transport, stateless, JSON
 * responses only (no SSE stream, no session id). Every client message is a
 * POST to /mcp carrying one JSON-RPC message (or, for 2025-03-26 clients, a
 * batch); requests get an `application/json` response, notifications a
 * bare 202.
 *
 * Permissions: the caller authenticates with the same Bearer credential as
 * the API (`wst_` token or session), and every tool acts by calling the
 * worker's own routes with that credential (see tools.ts `callApi`). So
 * the MCP can never do more than the user and the token's scopes allow —
 * there is no second copy of the rules here. `tools/list` additionally
 * hides tools the token's scopes could never use.
 */
import type { AuthContext } from '../types';
import { PROMPTS, renderPrompt } from './prompts';
import { findTool, type ToolContext, toolError, toolsFor, validateArgs } from './tools';

/** Protocol revisions this server speaks (newest first). */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const SERVER_INFO = { name: 'sentinel', title: 'Sentinel', version: '1.0.0' };

export const SERVER_INSTRUCTIONS = `Sentinel is a self-hosted, Sentry-compatible error tracker. With these tools you can connect an app end to end — create its project, get the DSN and a platform-specific setup guide, send a test event — and then triage what it reports.

Permissions: you act as the user who owns the token, with their role in each project (owner, admin or member) and only within the token's scopes (read, write, projects). Call whoami first to see what you may do; get_project lists the allowed actions per project ("can"). If a tool answers with a permission error, explain it to the user instead of retrying.

Ask the user before calling any tool that changes something. rotate_dsn and delete_project also need the project slug repeated in "confirm".

Typical flow to connect an app: list_platforms → create_project (or pick one with list_projects) → get_setup_guide → apply the steps in the app's code → send_test_event → list_issues.`;

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: JsonRpcId;
	method?: unknown;
	params?: unknown;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function rpcResult(id: JsonRpcId, result: unknown) {
	return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/** Handles one POST /mcp. `ctx` carries the caller and the internal API. */
export async function handleMcpPost(request: Request, ctx: ToolContext): Promise<Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return json(rpcError(null, PARSE_ERROR, 'Parse error'), 400);
	}

	const batch = Array.isArray(payload);
	const messages = (batch ? payload : [payload]) as unknown[];
	if (messages.length === 0) {
		return json(rpcError(null, INVALID_REQUEST, 'Empty batch'), 400);
	}

	const responses: unknown[] = [];
	for (const message of messages) {
		const response = await handleMessage(message, ctx);
		if (response) responses.push(response);
	}

	// Only notifications/responses from the client: nothing to answer.
	if (responses.length === 0) return new Response(null, { status: 202 });
	return json(batch ? responses : responses[0]);
}

async function handleMessage(raw: unknown, ctx: ToolContext): Promise<unknown | null> {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return rpcError(null, INVALID_REQUEST, 'Invalid request');
	}
	const message = raw as JsonRpcMessage;
	const hasId = 'id' in message && message.id !== undefined;
	const id: JsonRpcId = hasId ? (message.id as JsonRpcId) : null;

	if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
		// A JSON-RPC *response* from the client (e.g. to a ping we never send) or junk.
		if (!('method' in message) && ('result' in message || 'error' in message)) return null;
		return rpcError(id, INVALID_REQUEST, 'Invalid request');
	}

	// Notifications (no id) get no response.
	if (!hasId) return null;

	const params = (message.params ?? {}) as Record<string, unknown>;
	try {
		switch (message.method) {
			case 'initialize':
				return rpcResult(id, initializeResult(params));
			case 'ping':
				return rpcResult(id, {});
			case 'tools/list':
				return rpcResult(id, { tools: toolsFor(ctx.auth).map((t) => t.definition) });
			case 'tools/call':
				return rpcResult(id, await callTool(params, ctx));
			case 'prompts/list':
				return rpcResult(id, { prompts: PROMPTS.map((p) => p.definition) });
			case 'prompts/get': {
				const rendered = renderPrompt(params.name, params.arguments);
				if (!rendered)
					return rpcError(id, INVALID_PARAMS, `Unknown prompt: ${String(params.name)}`);
				return rpcResult(id, rendered);
			}
			case 'resources/list':
				return rpcResult(id, { resources: [] });
			case 'resources/templates/list':
				return rpcResult(id, { resourceTemplates: [] });
			case 'logging/setLevel':
				return rpcResult(id, {});
			default:
				return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
		}
	} catch (error) {
		if (error instanceof InvalidParamsError) return rpcError(id, INVALID_PARAMS, error.message);
		console.error('mcp: internal error', error);
		return rpcError(id, -32603, 'Internal error');
	}
}

class InvalidParamsError extends Error {}

function initializeResult(params: Record<string, unknown>) {
	const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
	const protocolVersion =
		requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
			? requested
			: SUPPORTED_PROTOCOL_VERSIONS[0];
	return {
		protocolVersion,
		capabilities: {
			tools: { listChanged: false },
			prompts: { listChanged: false },
			resources: { listChanged: false },
			logging: {},
		},
		serverInfo: SERVER_INFO,
		instructions: SERVER_INSTRUCTIONS,
	};
}

async function callTool(params: Record<string, unknown>, ctx: ToolContext) {
	const name = params.name;
	if (typeof name !== 'string') throw new InvalidParamsError('tools/call needs a tool name');
	const tool = findTool(name);
	if (!tool) throw new InvalidParamsError(`Unknown tool: ${name}`);

	// Same visibility rule as tools/list: a token whose scopes can never use
	// the tool gets a clear tool error, not a silent attempt.
	if (!toolsFor(ctx.auth).includes(tool)) {
		return toolError(
			`${name} needs the "${tool.scope}" scope${tool.adminOnly ? ' and an admin account' : ''}; this token cannot use it.`,
		);
	}

	const args = (params.arguments ?? {}) as Record<string, unknown>;
	const invalid = validateArgs(tool.definition.inputSchema, args);
	if (invalid) return toolError(`Invalid arguments for ${name}: ${invalid}`);

	return tool.run(args, ctx);
}

export type { AuthContext, ToolContext };
