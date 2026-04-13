import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

// --- Types ---

export interface DeployParams {
	/** Name of the target Worker script to gradually deploy */
	scriptName: string;
	/** The new version ID to roll out (from `wrangler versions upload`) */
	newVersionId: string;
	/** Traffic percentage steps to progress through. Default: [10, 25, 50, 75, 100] */
	steps?: number[];
	/** Minutes to wait between each step. Default: 5 */
	waitMinutes?: number;
	/** Max error rate (%) for the new version before triggering rollback. Default: 5 */
	errorThreshold?: number;
}

interface DeploymentVersion {
	version_id: string;
	percentage: number;
}

interface Deployment {
	id: string;
	strategy: string;
	versions: DeploymentVersion[];
	created_on: string;
	author_email?: string;
}

/** Response shape for GET /deployments (list) */
interface ListDeploymentsResponse {
	result: {
		deployments: Deployment[];
	};
	success: boolean;
	errors: Array<{ message: string }>;
}

/** Response shape for POST /deployments (create) */
interface CreateDeploymentResponse {
	result: Deployment;
	success: boolean;
	errors: Array<{ message: string }>;
}

interface HealthCheckResult {
	errorRate: number;
	totalRequests: number;
	errors: number;
	passed: boolean;
}

interface Env {
	DEPLOY_WORKFLOW: Workflow;
	CF_API_TOKEN: string;
	ACCOUNT_ID: string;
	ERROR_THRESHOLD: string;
	DEFAULT_WAIT_MINUTES: string;
}

// --- Helpers ---

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

async function cfApiRequest<T>(
	path: string,
	token: string,
	options: { method?: string; body?: unknown } = {},
): Promise<T> {
	const res = await fetch(`${CF_API_BASE}${path}`, {
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

/**
 * Query Workers analytics via the Cloudflare GraphQL API to get the error rate
 * for a specific script version over the past N minutes.
 *
 * We query `workersInvocationsAdaptive` grouped by `status` (the invocation
 * outcome).  Rows with status "success" or "clientDisconnected" are healthy;
 * everything else (scriptThrewException, exceededResources, internalError, …)
 * counts as an error.
 *
 * `sum.errors` counts *runtime-level* errors, and `sum.requests` counts
 * invocations. Returning an HTTP 500 from user code is still a "success"
 * invocation, so we additionally check the `status` dimension.
 */
async function checkVersionHealth(
	accountId: string,
	token: string,
	scriptName: string,
	versionId: string,
	windowMinutes: number,
): Promise<HealthCheckResult> {
	const now = new Date();
	const since = new Date(now.getTime() - windowMinutes * 60 * 1000);

	// The query groups by `status` so we can bucket success vs error invocations.
	// `scriptVersion` is passed as a proper GraphQL variable.
	const query = `
		query WorkerVersionHealth(
			$accountTag: string!
			$scriptName: string!
			$scriptVersion: string!
			$since: string!
			$until: string!
		) {
			viewer {
				accounts(filter: { accountTag: $accountTag }) {
					workersInvocationsAdaptive(
						filter: {
							scriptName: $scriptName
							scriptVersion: $scriptVersion
							datetime_geq: $since
							datetime_leq: $until
						}
						limit: 10000
					) {
						sum {
							requests
							errors
						}
						dimensions {
							status
						}
					}
				}
			}
		}
	`;

	const graphqlRes = await fetch("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query,
			variables: {
				accountTag: accountId,
				scriptName,
				scriptVersion: versionId,
				since: since.toISOString(),
				until: now.toISOString(),
			},
		}),
	});

	if (!graphqlRes.ok) {
		console.warn(
			`GraphQL analytics query failed (${graphqlRes.status}), skipping health check`,
		);
		return { errorRate: 0, totalRequests: 0, errors: 0, passed: true };
	}

	const data = (await graphqlRes.json()) as {
		data?: {
			viewer?: {
				accounts?: Array<{
					workersInvocationsAdaptive?: Array<{
						sum?: { requests: number; errors: number };
						dimensions?: { status: string };
					}>;
				}>;
			};
		};
		errors?: Array<{ message: string }>;
	};

	if (data.errors && data.errors.length > 0) {
		console.warn(
			`GraphQL returned errors: ${data.errors.map((e) => e.message).join(", ")}. Skipping health check.`,
		);
		return { errorRate: 0, totalRequests: 0, errors: 0, passed: true };
	}

	const invocations =
		data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

	// Healthy statuses — everything else is an error
	const HEALTHY_STATUSES = new Set(["success", "clientDisconnected"]);

	let totalRequests = 0;
	let totalErrors = 0;

	for (const inv of invocations) {
		const requests = inv.sum?.requests ?? 0;
		const runtimeErrors = inv.sum?.errors ?? 0;
		const status = inv.dimensions?.status ?? "";

		totalRequests += requests;

		// Count as errors: runtime errors from sum.errors, PLUS any invocations
		// whose status indicates a non-success outcome
		if (!HEALTHY_STATUSES.has(status)) {
			totalErrors += requests;
		} else {
			totalErrors += runtimeErrors;
		}
	}

	console.log(
		`Analytics for version ${versionId}: ${totalRequests} total requests, ${totalErrors} errors across ${invocations.length} status groups`,
	);

	// If there is zero traffic, we can't evaluate health — pass the check
	if (totalRequests === 0) {
		console.log(
			`No requests observed for version ${versionId}, insufficient data - passing health check`,
		);
		return {
			errorRate: 0,
			totalRequests,
			errors: totalErrors,
			passed: true,
		};
	}

	const errorRate = (totalErrors / totalRequests) * 100;
	return { errorRate, totalRequests, errors: totalErrors, passed: false }; // `passed` is evaluated by caller against threshold
}

// --- Workflow ---

export class GradualDeployWorkflow extends WorkflowEntrypoint<Env, DeployParams> {
	async run(event: WorkflowEvent<DeployParams>, step: WorkflowStep) {
		const {
			scriptName,
			newVersionId,
			steps: percentageSteps = [10, 25, 50, 75, 100],
			waitMinutes = parseInt(this.env.DEFAULT_WAIT_MINUTES) || 5,
			errorThreshold = parseInt(this.env.ERROR_THRESHOLD) || 5,
		} = event.payload;

		const accountId = this.env.ACCOUNT_ID;
		const token = this.env.CF_API_TOKEN;

		// Step 1: Fetch current deployment to find the old version
		const oldVersionId = await step.do(
			"fetch-current-deployment",
			{
				retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
				timeout: "30 seconds",
			},
			async () => {
				const response = await cfApiRequest<ListDeploymentsResponse>(
					`/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
					token,
				);

				if (!response.success) {
					throw new Error(
						`Failed to fetch deployments for ${scriptName}: ${JSON.stringify(response.errors)}`,
					);
				}

				// The first deployment in the list is the latest one actively serving traffic
				const latestDeployment = response.result?.deployments?.[0];

				if (!latestDeployment?.versions?.length) {
					throw new Error(
						`No active deployment found for ${scriptName}. Deploy the Worker at least once before using gradual deployments.`,
					);
				}

				// Find the version currently receiving the most traffic
				const sorted = [...latestDeployment.versions].sort(
					(a, b) => b.percentage - a.percentage,
				);
				const currentVersion = sorted[0].version_id;

				if (currentVersion === newVersionId) {
					throw new Error(
						`New version ${newVersionId} is already the primary deployment`,
					);
				}

				console.log(
					`Current primary version: ${currentVersion} at ${sorted[0].percentage}%`,
				);
				return currentVersion;
			},
		);

		// Step 2: Iterate through percentage steps
		for (const targetPct of percentageSteps) {
			const oldPct = 100 - targetPct;

			// Deploy at this percentage
			await step.do(
				`deploy-at-${targetPct}pct`,
				{
					retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
					timeout: "60 seconds",
				},
				async () => {
					const versions: DeploymentVersion[] = [
						{ version_id: newVersionId, percentage: targetPct },
					];

					// Only include the old version if it still has traffic
					if (oldPct > 0) {
						versions.push({
							version_id: oldVersionId,
							percentage: oldPct,
						});
					}

					const result = await cfApiRequest<CreateDeploymentResponse>(
						`/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
						token,
						{
							method: "POST",
							body: {
								strategy: "percentage",
								versions,
							},
						},
					);

					if (!result.success) {
						throw new Error(
							`Failed to create deployment at ${targetPct}%: ${JSON.stringify(result.errors)}`,
						);
					}

					console.log(
						`Deployed: ${scriptName} new=${newVersionId}@${targetPct}% old=${oldVersionId}@${oldPct}%`,
					);

					return {
						deploymentId: result.result.id,
						newPct: targetPct,
						oldPct,
					};
				},
			);

			// If this is the final step (100%), we're done -- no need to wait or health check
			if (targetPct === 100) {
				break;
			}

			// Poll health every 15 seconds for the full wait period.
			// Each sleep + check is a durable step, so a failure triggers
			// an immediate rollback rather than waiting for the window to end.
			const HEALTH_CHECK_INTERVAL_SECONDS = 15;
			const totalChecks = Math.max(
				1,
				Math.floor((waitMinutes * 60) / HEALTH_CHECK_INTERVAL_SECONDS),
			);

			for (let checkIndex = 0; checkIndex < totalChecks; checkIndex++) {
				await step.sleep(
					`wait-at-${targetPct}pct-${checkIndex}`,
					`${HEALTH_CHECK_INTERVAL_SECONDS} seconds`,
				);

				const health = await step.do(
					`health-check-at-${targetPct}pct-${checkIndex}`,
					{
						retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
						timeout: "30 seconds",
					},
					async () => {
						// Look back over a rolling window equal to the time elapsed so far
						const elapsedMinutes = Math.max(
							1,
							((checkIndex + 1) * HEALTH_CHECK_INTERVAL_SECONDS) / 60,
						);
						const result = await checkVersionHealth(
							accountId,
							token,
							scriptName,
							newVersionId,
							elapsedMinutes,
						);

						const passed = result.errorRate <= errorThreshold;

						console.log(
							`Health check ${checkIndex + 1}/${totalChecks} at ${targetPct}%: ` +
								`${result.totalRequests} reqs, ${result.errors} errs ` +
								`(${result.errorRate.toFixed(2)}%), threshold=${errorThreshold}% => ${passed ? "PASS" : "FAIL"}`,
						);

						return { ...result, passed };
					},
				);

				// If any health check fails, roll back immediately
				if (!health.passed) {
					await step.do(
						"rollback",
						{
							retries: {
								limit: 5,
								delay: "5 seconds",
								backoff: "exponential",
							},
							timeout: "60 seconds",
						},
						async () => {
							const result = await cfApiRequest<CreateDeploymentResponse>(
								`/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
								token,
								{
									method: "POST",
									body: {
										strategy: "percentage",
										versions: [
											{
												version_id: oldVersionId,
												percentage: 100,
											},
										],
									},
								},
							);

							if (!result.success) {
								throw new Error(
									`CRITICAL: Rollback failed: ${JSON.stringify(result.errors)}`,
								);
							}

							console.log(
								`ROLLED BACK: ${scriptName} reverted to ${oldVersionId}@100%`,
							);

							return {
								rolledBack: true,
								reason: `Error rate ${health.errorRate.toFixed(2)}% exceeded threshold ${errorThreshold}% at ${targetPct}% deployment (check ${checkIndex + 1}/${totalChecks})`,
								oldVersionId,
							};
						},
					);

					return {
						status: "rolled_back",
						scriptName,
						newVersionId,
						oldVersionId,
						failedAtPercentage: targetPct,
						failedAtCheck: checkIndex + 1,
						totalChecks,
						errorRate: health.errorRate,
						errorThreshold,
					};
				}
			}

			console.log(
				`All ${totalChecks} health checks passed at ${targetPct}%, proceeding to next step`,
			);
		}

		// All steps completed successfully
		return {
			status: "completed",
			scriptName,
			newVersionId,
			oldVersionId,
			finalPercentage: 100,
		};
	}
}
