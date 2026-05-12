import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { cfApiRequest, type Env } from "./api";
import { checkHealth, type HealthCheckStrategy } from "./health";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeployParams {
	/** Name of the target Worker script to gradually deploy */
	scriptName: string;
	/** The new version ID to roll out (from `wrangler versions upload`) */
	newVersionId: string;
	/** Traffic percentage steps to progress through (default: [10, 25, 50, 75, 100]) */
	steps?: number[];
	/** Minutes to soak at each percentage step (default: 5) */
	soakMinutes?: number;
	/** Max error rate (%) before triggering rollback (default: 5) */
	errorThreshold?: number;
	/**
	 * Health check strategy:
	 *   "wobs_query"  — poll Workers Observability telemetry API
	 *   "wobs_alerts" — check Cloudflare Notification alert history
	 */
	healthCheckStrategy?: HealthCheckStrategy;
	/**
	 * Optional: URL(s) to smoke test via the version override header before
	 * sending any real traffic. The deployer will deploy at 0%, hit these URLs
	 * targeting the new version, and only proceed if they return 2xx.
	 * If omitted, the smoke test step is skipped.
	 */
	smokeTestUrls?: string[];
}

interface DeploymentVersion {
	version_id: string;
	percentage: number;
}

interface Deployment {
	id: string;
	strategy: string;
	versions: DeploymentVersion[];
}

interface ListDeploymentsResponse {
	result: { deployments: Deployment[] };
	success: boolean;
	errors: Array<{ message: string }>;
}

interface CreateDeploymentResponse {
	result: Deployment;
	success: boolean;
	errors: Array<{ message: string }>;
}

// ---------------------------------------------------------------------------
// Workflow
//
//   1. Fetch current (stable) deployment
//   2. Deploy new version at 0% — no real traffic
//   3. Smoke test via version override header (optional)
//   4. For each step (10% → 25% → 50% → ... → 100%):
//      a. Shift traffic to this percentage
//      b. Soak: poll Workers Observability every 15s for soakMinutes
//      c. If observability metrics breach threshold → rollback to stable
//   5. Reach 100% → done
//
// ---------------------------------------------------------------------------

export class GradualDeployWorkflow extends WorkflowEntrypoint<Env, DeployParams> {
	async run(event: WorkflowEvent<DeployParams>, step: WorkflowStep) {
		const {
			scriptName,
			newVersionId,
			steps: percentageSteps = [10, 25, 50, 75, 100],
			soakMinutes = parseInt(this.env.DEFAULT_WAIT_MINUTES) || 5,
			errorThreshold = parseInt(this.env.ERROR_THRESHOLD) || 5,
			healthCheckStrategy = (this.env.DEFAULT_HEALTH_CHECK_STRATEGY as HealthCheckStrategy) || "wobs_query",
			smokeTestUrls,
		} = event.payload;

		const accountId = this.env.ACCOUNT_ID;
		const token = this.env.CF_API_TOKEN;

		console.log(
			`[gradual-deploy] script=${scriptName} version=${newVersionId} ` +
				`strategy=${healthCheckStrategy} steps=${JSON.stringify(percentageSteps)} ` +
				`soak=${soakMinutes}m threshold=${errorThreshold}%` +
				(smokeTestUrls?.length ? ` smokeTests=${smokeTestUrls.length} URLs` : ""),
		);

		// ── Step 1: Find the current stable version ──────────────────────────

		const stableVersionId = await step.do(
			"fetch-stable-version",
			{
				retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
				timeout: "30 seconds",
			},
			async () => {
				const res = await cfApiRequest<ListDeploymentsResponse>(
					`/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
					token,
				);

				if (!res.success) {
					throw new Error(
						`Failed to fetch deployments: ${JSON.stringify(res.errors)}`,
					);
				}

				const latest = res.result?.deployments?.[0];
				if (!latest?.versions?.length) {
					throw new Error(
						`No active deployment for ${scriptName}. Deploy it at least once first.`,
					);
				}

				const primary = [...latest.versions].sort(
					(a, b) => b.percentage - a.percentage,
				)[0];

				if (primary.version_id === newVersionId) {
					throw new Error(
						`Version ${newVersionId} is already the primary deployment.`,
					);
				}

				console.log(
					`Stable version: ${primary.version_id} at ${primary.percentage}%`,
				);
				return primary.version_id;
			},
		);

		// Helper: deploy a specific traffic split
		const deploy = async (
			stepName: string,
			newPct: number,
			stablePct: number,
		) => {
			return step.do(
				stepName,
				{
					retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
					timeout: "60 seconds",
				},
			async () => {
				const versions: DeploymentVersion[] = [];

					// 0% deploy: both versions must be present for version override header to work
					if (newPct === 0) {
						versions.push({ version_id: newVersionId, percentage: 0 });
						versions.push({ version_id: stableVersionId, percentage: 100 });
					} else {
						versions.push({ version_id: newVersionId, percentage: newPct });
						if (stablePct > 0) {
							versions.push({ version_id: stableVersionId, percentage: stablePct });
						}
					}

					const res = await cfApiRequest<CreateDeploymentResponse>(
						`/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
						token,
						{
							method: "POST",
							body: { strategy: "percentage", versions },
						},
					);

					if (!res.success) {
						throw new Error(
							`Deploy failed: ${JSON.stringify(res.errors)}`,
						);
					}

					console.log(
						`Deployed: new@${newPct}% stable@${stablePct}%`,
					);
				},
			);
		};

		// Helper: rollback to stable
		const rollback = async (reason: string) => {
			await step.do(
				"rollback",
				{
					retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
					timeout: "60 seconds",
				},
				async () => {
					const res = await cfApiRequest<CreateDeploymentResponse>(
						`/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
						token,
						{
							method: "POST",
							body: {
								strategy: "percentage",
								versions: [
									{ version_id: stableVersionId, percentage: 100 },
								],
							},
						},
					);

					if (!res.success) {
						throw new Error(
							`CRITICAL — rollback failed: ${JSON.stringify(res.errors)}`,
						);
					}

					console.log(`ROLLED BACK to ${stableVersionId}@100% — ${reason}`);
				},
			);
		};

		// ── Step 2: Deploy at 0% (canary position) ──────────────────────────

		if (smokeTestUrls?.length) {
			await deploy("deploy-at-0pct", 0, 100);
		}

		// ── Step 3: Smoke test via version override header ───────────────────

		if (smokeTestUrls?.length) {
			const smokeResult = await step.do(
				"smoke-test",
				{
					retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
					timeout: "60 seconds",
				},
				async () => {
					const results: Array<{
						url: string;
						status: number;
						ok: boolean;
					}> = [];

					for (const url of smokeTestUrls) {
						try {
							const res = await fetch(url, {
								headers: {
									"Cloudflare-Workers-Version-Overrides":
										`${scriptName}="${newVersionId}"`,
								},
							});
							results.push({
								url,
								status: res.status,
								ok: res.status >= 200 && res.status < 400,
							});
							console.log(
								`Smoke test ${url} → ${res.status} ${res.ok ? "OK" : "FAIL"}`,
							);
						} catch (err) {
							results.push({ url, status: 0, ok: false });
							console.log(
								`Smoke test ${url} → NETWORK ERROR: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}

					const allPassed = results.every((r) => r.ok);
					return { results, allPassed };
				},
			);

			if (!smokeResult.allPassed) {
				const failed = smokeResult.results
					.filter((r) => !r.ok)
					.map((r) => `${r.url} (${r.status})`)
					.join(", ");

				await rollback(`Smoke test failed: ${failed}`);

				return {
					status: "rolled_back",
					reason: "smoke_test_failed",
					scriptName,
					newVersionId,
					stableVersionId,
					smokeTestResults: smokeResult.results,
				};
			}

			console.log("All smoke tests passed — proceeding to gradual rollout");
		}

		// ── Step 4: Gradual rollout with soak at each step ──────────────────

		for (const targetPct of percentageSteps) {
			const stablePct = 100 - targetPct;

			await deploy(`deploy-at-${targetPct}pct`, targetPct, stablePct);

			// At 100% we're done — no soak needed
			if (targetPct === 100) break;

			// Soak: poll observability every 15s for soakMinutes
			const INTERVAL_SECONDS = 15;
			const totalChecks = Math.max(
				1,
				Math.floor((soakMinutes * 60) / INTERVAL_SECONDS),
			);

			for (let i = 0; i < totalChecks; i++) {
				await step.sleep(
					`soak-${targetPct}pct-${i}`,
					`${INTERVAL_SECONDS} seconds`,
				);

				const health = await step.do(
					`check-${targetPct}pct-${i}`,
					{
						retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
						timeout: "30 seconds",
					},
					async () => {
						const elapsedMinutes = Math.max(
							1,
							((i + 1) * INTERVAL_SECONDS) / 60,
						);

						return checkHealth(healthCheckStrategy, {
							accountId,
							token,
							scriptName,
							versionId: newVersionId,
							windowMinutes: elapsedMinutes,
							errorThreshold,
						});
					},
				);

				console.log(
					`[${targetPct}%] check ${i + 1}/${totalChecks}: ` +
						`reqs=${health.totalRequests} errs=${health.errors} ` +
						`rate=${health.errorRate >= 0 ? health.errorRate.toFixed(2) + "%" : "N/A"} ` +
						`=> ${health.passed ? "PASS" : "FAIL"}`,
				);

				if (!health.passed) {
					await rollback(
						`Error rate breached threshold at ${targetPct}% ` +
							`(${health.errorRate >= 0 ? health.errorRate.toFixed(2) + "%" : "alert fired"} > ${errorThreshold}%)`,
					);

					return {
						status: "rolled_back",
						reason: "soak_failed",
						scriptName,
						newVersionId,
						stableVersionId,
						failedAtPercentage: targetPct,
						failedAtCheck: i + 1,
						totalChecks,
						errorRate: health.errorRate,
						errorThreshold,
						strategy: healthCheckStrategy,
					};
				}
			}

			console.log(`Soak passed at ${targetPct}% — progressing`);
		}

		// ── Done ─────────────────────────────────────────────────────────────

		return {
			status: "completed",
			scriptName,
			newVersionId,
			stableVersionId,
			finalPercentage: 100,
			strategy: healthCheckStrategy,
		};
	}
}
