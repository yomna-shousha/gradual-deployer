import { GradualDeployWorkflow, type DeployParams } from "./workflow";

export { GradualDeployWorkflow };

interface Env {
	DEPLOY_WORKFLOW: Workflow;
	CF_API_TOKEN: string;
	ACCOUNT_ID: string;
	ERROR_THRESHOLD: string;
	DEFAULT_WAIT_MINUTES: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// POST /deploy - Start a new gradual deployment
		if (request.method === "POST" && url.pathname === "/deploy") {
			return handleDeploy(request, env);
		}

		// GET /status/:id - Check workflow instance status
		if (request.method === "GET" && url.pathname.startsWith("/status/")) {
			const instanceId = url.pathname.replace("/status/", "");
			return handleStatus(instanceId, env);
		}

		// GET / - Show usage info
		if (request.method === "GET" && url.pathname === "/") {
			return new Response(
				JSON.stringify(
					{
						service: "gradual-deployer",
						endpoints: {
							"POST /deploy": {
								description: "Start a gradual deployment",
								body: {
									scriptName: "string (required) - target Worker name",
									newVersionId:
										"string (required) - version ID from `wrangler versions upload`",
									steps: "number[] (optional) - percentage steps, default [10, 25, 50, 75, 100]",
									waitMinutes:
										"number (optional) - minutes between steps, default 5",
									errorThreshold:
										"number (optional) - max error rate %, default 5",
								},
							},
							"GET /status/:instanceId": {
								description: "Check status of a deployment workflow",
							},
						},
					},
					null,
					2,
				),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleDeploy(request: Request, env: Env): Promise<Response> {
	let body: DeployParams;

	try {
		body = await request.json<DeployParams>();
	} catch {
		return new Response(
			JSON.stringify({ error: "Invalid JSON body" }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	// Validate required fields
	if (!body.scriptName || !body.newVersionId) {
		return new Response(
			JSON.stringify({
				error: "Missing required fields: scriptName and newVersionId",
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	// Validate steps if provided
	if (body.steps) {
		if (!Array.isArray(body.steps) || body.steps.some((s) => s < 1 || s > 100)) {
			return new Response(
				JSON.stringify({
					error: "steps must be an array of numbers between 1 and 100",
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}

		// Ensure steps are sorted and the last step is 100
		const sorted = [...body.steps].sort((a, b) => a - b);
		if (sorted[sorted.length - 1] !== 100) {
			return new Response(
				JSON.stringify({
					error: "The last step must be 100 (full deployment)",
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}
		body.steps = sorted;
	}

	// Create a unique instance ID based on script + version + timestamp
	const instanceId = `${body.scriptName}-${body.newVersionId.slice(0, 8)}-${Date.now()}`;

	try {
		const instance = await env.DEPLOY_WORKFLOW.create({
			id: instanceId,
			params: body,
		});

		return new Response(
			JSON.stringify({
				message: "Gradual deployment started",
				instanceId: instance.id,
				statusUrl: `/status/${instance.id}`,
				params: {
					scriptName: body.scriptName,
					newVersionId: body.newVersionId,
					steps: body.steps ?? [10, 25, 50, 75, 100],
					waitMinutes: body.waitMinutes ?? 5,
					errorThreshold: body.errorThreshold ?? 5,
				},
			}),
			{
				status: 201,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (err) {
		return new Response(
			JSON.stringify({
				error: "Failed to start workflow",
				details: err instanceof Error ? err.message : String(err),
			}),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
}

async function handleStatus(instanceId: string, env: Env): Promise<Response> {
	try {
		const instance = await env.DEPLOY_WORKFLOW.get(instanceId);
		const status = await instance.status();

		return new Response(
			JSON.stringify({
				instanceId,
				status,
			}),
			{
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (err) {
		return new Response(
			JSON.stringify({
				error: "Workflow instance not found",
				instanceId,
				details: err instanceof Error ? err.message : String(err),
			}),
			{ status: 404, headers: { "Content-Type": "application/json" } },
		);
	}
}
