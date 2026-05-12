import { GradualDeployWorkflow, type DeployParams } from "./workflow";
import type { Env } from "./api";
import type { HealthCheckStrategy } from "./health";

export { GradualDeployWorkflow };

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/deploy") {
			return handleDeploy(request, env);
		}

		if (request.method === "GET" && url.pathname.startsWith("/status/")) {
			const instanceId = url.pathname.replace("/status/", "");
			return handleStatus(instanceId, env);
		}

		if (request.method === "GET" && url.pathname === "/") {
			return json({
				service: "gradual-deployer",
				usage: {
					"POST /deploy": {
						scriptName: "string — target Worker name",
						newVersionId: "string — version ID from wrangler versions upload",
						steps: "number[] — rollout percentages (default: [10, 25, 50, 75, 100])",
						soakMinutes: "number — minutes to soak at each step (default: 5)",
						errorThreshold: "number — max error rate % before rollback (default: 5)",
						healthCheckStrategy: "\"wobs_query\" | \"wobs_alerts\" — how to evaluate health (default: wobs_query)",
						smokeTestUrls: "string[] — URLs to hit via version override header before any real traffic (optional)",
					},
					"GET /status/:id": "Check workflow status",
				},
				flow: [
					"1. Fetch current stable version",
					"2. Deploy new version at 0% (if smokeTestUrls provided)",
					"3. Smoke test via Cloudflare-Workers-Version-Overrides header",
					"4. Progress through percentage steps (10% → 25% → 50% → ...)",
					"5. Soak at each step — poll Workers Observability for errors",
					"6. If error rate breaches threshold → instant rollback to stable",
					"7. Reach 100% → done",
				],
			});
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------

async function handleDeploy(request: Request, env: Env): Promise<Response> {
	let body: DeployParams;

	try {
		body = await request.json<DeployParams>();
	} catch {
		return json({ error: "Invalid JSON body" }, 400);
	}

	if (!body.scriptName || !body.newVersionId) {
		return json(
			{ error: "Missing required fields: scriptName and newVersionId" },
			400,
		);
	}

	// Validate steps
	if (body.steps) {
		if (
			!Array.isArray(body.steps) ||
			body.steps.some((s) => s < 1 || s > 100)
		) {
			return json(
				{ error: "steps must be an array of numbers between 1 and 100" },
				400,
			);
		}
		const sorted = [...body.steps].sort((a, b) => a - b);
		if (sorted[sorted.length - 1] !== 100) {
			return json({ error: "Last step must be 100" }, 400);
		}
		body.steps = sorted;
	}

	// Validate strategy
	const validStrategies: HealthCheckStrategy[] = ["wobs_query", "wobs_alerts"];
	if (
		body.healthCheckStrategy &&
		!validStrategies.includes(body.healthCheckStrategy)
	) {
		return json(
			{ error: `healthCheckStrategy must be one of: ${validStrategies.join(", ")}` },
			400,
		);
	}

	// Validate smoke test URLs
	if (body.smokeTestUrls) {
		if (!Array.isArray(body.smokeTestUrls)) {
			return json({ error: "smokeTestUrls must be an array of URLs" }, 400);
		}
		for (const url of body.smokeTestUrls) {
			try {
				new URL(url);
			} catch {
				return json({ error: `Invalid smoke test URL: ${url}` }, 400);
			}
		}
	}

	const instanceId = `${body.scriptName}-${body.newVersionId.slice(0, 8)}-${Date.now()}`;

	try {
		const instance = await env.DEPLOY_WORKFLOW.create({
			id: instanceId,
			params: body,
		});

		return json(
			{
				message: "Gradual deployment started",
				instanceId: instance.id,
				statusUrl: `/status/${instance.id}`,
				params: {
					scriptName: body.scriptName,
					newVersionId: body.newVersionId,
					steps: body.steps ?? [10, 25, 50, 75, 100],
					soakMinutes: body.soakMinutes ?? 5,
					errorThreshold: body.errorThreshold ?? 5,
					healthCheckStrategy:
						body.healthCheckStrategy ??
						env.DEFAULT_HEALTH_CHECK_STRATEGY ??
						"wobs_query",
					smokeTestUrls: body.smokeTestUrls ?? [],
				},
			},
			201,
		);
	} catch (err) {
		return json(
			{
				error: "Failed to start workflow",
				details: err instanceof Error ? err.message : String(err),
			},
			500,
		);
	}
}

async function handleStatus(instanceId: string, env: Env): Promise<Response> {
	try {
		const instance = await env.DEPLOY_WORKFLOW.get(instanceId);
		const status = await instance.status();
		return json({ instanceId, status });
	} catch (err) {
		return json(
			{
				error: "Workflow instance not found",
				instanceId,
				details: err instanceof Error ? err.message : String(err),
			},
			404,
		);
	}
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
