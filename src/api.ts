/**
 * Shared Cloudflare API helpers and environment types.
 */

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export interface Env {
	DEPLOY_WORKFLOW: Workflow;
	CF_API_TOKEN: string;
	ACCOUNT_ID: string;
	ERROR_THRESHOLD: string;
	DEFAULT_WAIT_MINUTES: string;
	DEFAULT_HEALTH_CHECK_STRATEGY: string;
}

export async function cfApiRequest<T>(
	path: string,
	token: string,
	options: { method?: string; body?: unknown } = {},
): Promise<T> {
	const url = path.startsWith("http")
		? path
		: `${CF_API_BASE}${path}`;

	const res = await fetch(url, {
		method: options.method ?? "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Cloudflare API error (${res.status}): ${text}`);
	}

	return res.json() as Promise<T>;
}
