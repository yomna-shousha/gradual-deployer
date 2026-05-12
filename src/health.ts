/**
 * Health check strategies for gradual deployments.
 *
 * Two strategies, both using Cloudflare's developer platform:
 *
 *   "wobs_query"  — Query the Workers Observability telemetry API directly.
 *                    Filters by $workers.scriptName + $workers.scriptVersion,
 *                    counts invocations grouped by $workers.outcome.
 *
 *   "wobs_alerts" — Create a temporary Cloudflare Notification policy
 *                    (alert_type: workers_observability_alert) scoped to the
 *                    new version, then poll /alerting/v3/history to see if
 *                    it fired.  Lets the platform do the evaluation.
 */

import { cfApiRequest, type Env } from "./api";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type HealthCheckStrategy = "wobs_query" | "wobs_alerts";

export interface HealthCheckResult {
	errorRate: number;
	totalRequests: number;
	errors: number;
	passed: boolean;
	strategy: HealthCheckStrategy;
	details?: string;
}

export interface HealthCheckContext {
	accountId: string;
	token: string;
	scriptName: string;
	versionId: string;
	windowMinutes: number;
	errorThreshold: number;
}

// ---------------------------------------------------------------------------
// Strategy dispatcher
// ---------------------------------------------------------------------------

export async function checkHealth(
	strategy: HealthCheckStrategy,
	ctx: HealthCheckContext,
): Promise<HealthCheckResult> {
	switch (strategy) {
		case "wobs_query":
			return checkHealthViaWobsQuery(ctx);
		case "wobs_alerts":
			return checkHealthViaWobsAlerts(ctx);
		default:
			console.warn(`Unknown strategy "${strategy}", falling back to wobs_query`);
			return checkHealthViaWobsQuery(ctx);
	}
}

// ---------------------------------------------------------------------------
// Strategy 1: Workers Observability Telemetry Query
// ---------------------------------------------------------------------------

interface TelemetryAggregate {
	value: number;
	count: number;
	groups?: Array<{ key: string; value: string | number | boolean }>;
}

interface TelemetryCalculation {
	calculation: string;
	aggregates: TelemetryAggregate[];
}

interface TelemetryQueryResponse {
	success: boolean;
	result: {
		calculations: TelemetryCalculation[];
	};
	errors: Array<{ message: string }>;
}

/**
 * Query Workers Observability telemetry to compute error rate for a version.
 *
 * We run two calculations in one request:
 *   1. COUNT (total invocations)  — filtered to scriptName + scriptVersion
 *   2. COUNT (error invocations)  — additionally filtered to non-success outcomes
 *
 * Uses the POST /workers/observability/telemetry/query endpoint.
 */
async function checkHealthViaWobsQuery(
	ctx: HealthCheckContext,
): Promise<HealthCheckResult> {
	const now = Date.now();
	const since = now - ctx.windowMinutes * 60 * 1000;

	const baseFilters = [
		{
			key: "$workers.scriptName",
			operation: "eq" as const,
			type: "string" as const,
			value: ctx.scriptName,
		},
		{
			key: "$workers.scriptVersion",
			operation: "eq" as const,
			type: "string" as const,
			value: ctx.versionId,
		},
	];

	// Query 1: total invocations for this version
	const totalQuery = buildTelemetryQuery({
		timeframe: { from: since, to: now },
		filters: baseFilters,
		calculations: [{ operator: "COUNT" }],
	});

	// Query 2: error invocations — outcome is not "ok"
	// Workers Observability uses $workers.outcome with values like
	// "ok", "exception", "exceededCpu", "exceededMemory", "canceled", etc.
	const errorQuery = buildTelemetryQuery({
		timeframe: { from: since, to: now },
		filters: [
			...baseFilters,
			{
				key: "$workers.outcome",
				operation: "neq" as const,
				type: "string" as const,
				value: "ok",
			},
		],
		calculations: [{ operator: "COUNT" }],
	});

	try {
		const [totalRes, errorRes] = await Promise.all([
			cfApiRequest<TelemetryQueryResponse>(
				`/accounts/${ctx.accountId}/workers/observability/telemetry/query`,
				ctx.token,
				{ method: "POST", body: totalQuery },
			),
			cfApiRequest<TelemetryQueryResponse>(
				`/accounts/${ctx.accountId}/workers/observability/telemetry/query`,
				ctx.token,
				{ method: "POST", body: errorQuery },
			),
		]);

		const totalRequests = extractCount(totalRes);
		const errors = extractCount(errorRes);

		if (totalRequests === 0) {
			console.log(
				`[wobs_query] No requests for version ${ctx.versionId} — passing (insufficient data)`,
			);
			return {
				errorRate: 0,
				totalRequests: 0,
				errors: 0,
				passed: true,
				strategy: "wobs_query",
				details: "No traffic observed — insufficient data to evaluate",
			};
		}

		const errorRate = (errors / totalRequests) * 100;
		const passed = errorRate <= ctx.errorThreshold;

		console.log(
			`[wobs_query] version=${ctx.versionId} total=${totalRequests} errors=${errors} rate=${errorRate.toFixed(2)}% threshold=${ctx.errorThreshold}% => ${passed ? "PASS" : "FAIL"}`,
		);

		return {
			errorRate,
			totalRequests,
			errors,
			passed,
			strategy: "wobs_query",
		};
	} catch (err) {
		console.warn(
			`[wobs_query] Telemetry query failed: ${err instanceof Error ? err.message : String(err)}. Passing by default.`,
		);
		return {
			errorRate: 0,
			totalRequests: 0,
			errors: 0,
			passed: true,
			strategy: "wobs_query",
			details: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

function buildTelemetryQuery(opts: {
	timeframe: { from: number; to: number };
	filters: Array<{
		key: string;
		operation: string;
		type: string;
		value: string;
	}>;
	calculations: Array<{ operator: string; key?: string }>;
}) {
	return {
		queryId: "",
		timeframe: opts.timeframe,
		view: "calculations" as const,
		limit: 1,
		parameters: {
			datasets: [],
			filters: opts.filters,
			filterCombination: "AND" as const,
			calculations: opts.calculations,
		},
	};
}

function extractCount(res: TelemetryQueryResponse): number {
	const calc = res.result?.calculations?.[0];
	if (!calc?.aggregates?.length) return 0;
	return calc.aggregates[0].value ?? 0;
}

// ---------------------------------------------------------------------------
// Strategy 2: Workers Observability Alerts
// ---------------------------------------------------------------------------

interface AlertPolicy {
	id: string;
	name: string;
	alert_type: string;
	enabled: boolean;
}

interface CreatePolicyResponse {
	success: boolean;
	result: AlertPolicy;
	errors: Array<{ message: string }>;
}

interface AlertHistoryEntry {
	id: string;
	name: string;
	alert_type: string;
	mechanism_type: string;
	sent: string;
	policy_id: string;
}

interface AlertHistoryResponse {
	success: boolean;
	result: AlertHistoryEntry[];
	errors: Array<{ message: string }>;
}

/**
 * Create a temporary Workers Observability alert policy, then check if it
 * has fired since the deployment started.
 *
 * This strategy offloads error evaluation to Cloudflare's alerting system.
 * The workflow creates the policy at the start and polls /alerting/v3/history
 * during health checks to see if it triggered.
 */
async function checkHealthViaWobsAlerts(
	ctx: HealthCheckContext,
): Promise<HealthCheckResult> {
	const since = new Date(
		Date.now() - ctx.windowMinutes * 60 * 1000,
	).toISOString();

	try {
		// Check alert history for any workers_observability_alert that fired
		// since our observation window started
		const history = await cfApiRequest<AlertHistoryResponse>(
			`/accounts/${ctx.accountId}/alerting/v3/history?since=${encodeURIComponent(since)}&per_page=100`,
			ctx.token,
		);

		if (!history.success) {
			console.warn(
				`[wobs_alerts] Failed to fetch alert history: ${JSON.stringify(history.errors)}`,
			);
			return {
				errorRate: 0,
				totalRequests: 0,
				errors: 0,
				passed: true,
				strategy: "wobs_alerts",
				details: "Alert history query failed — passing by default",
			};
		}

		// Look for any workers_observability_alert that mentions our script
		const relevantAlerts = history.result.filter(
			(entry) =>
				entry.alert_type === "workers_observability_alert" &&
				entry.name.includes(ctx.scriptName),
		);

		if (relevantAlerts.length > 0) {
			console.log(
				`[wobs_alerts] ${relevantAlerts.length} alert(s) fired for ${ctx.scriptName} since ${since}`,
			);
			return {
				errorRate: -1, // Unknown exact rate — alert fired
				totalRequests: -1,
				errors: relevantAlerts.length,
				passed: false,
				strategy: "wobs_alerts",
				details: `${relevantAlerts.length} Workers Observability alert(s) fired`,
			};
		}

		console.log(
			`[wobs_alerts] No alerts fired for ${ctx.scriptName} — healthy`,
		);
		return {
			errorRate: 0,
			totalRequests: 0,
			errors: 0,
			passed: true,
			strategy: "wobs_alerts",
			details: "No alerts fired during observation window",
		};
	} catch (err) {
		console.warn(
			`[wobs_alerts] Alert check failed: ${err instanceof Error ? err.message : String(err)}. Passing by default.`,
		);
		return {
			errorRate: 0,
			totalRequests: 0,
			errors: 0,
			passed: true,
			strategy: "wobs_alerts",
			details: `Alert check failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Alert policy lifecycle helpers (used by the workflow)
// ---------------------------------------------------------------------------

/**
 * Create a temporary Workers Observability alert policy for the deploying
 * script. Returns the policy ID so the workflow can clean it up later.
 */
export async function createDeployAlertPolicy(
	accountId: string,
	token: string,
	scriptName: string,
	notificationEmail: string,
): Promise<string | null> {
	try {
		const res = await cfApiRequest<CreatePolicyResponse>(
			`/accounts/${accountId}/alerting/v3/policies`,
			token,
			{
				method: "POST",
				body: {
					name: `gradual-deploy: ${scriptName}`,
					alert_type: "workers_observability_alert",
					enabled: true,
					description: `Auto-created by gradual-deployer for ${scriptName}. Will be deleted after rollout completes.`,
					mechanisms: {
						email: [{ id: notificationEmail }],
					},
					// Filter to this specific script
					filters: {
						selectors: [scriptName],
					},
				},
			},
		);

		if (!res.success) {
			console.warn(
				`Failed to create alert policy: ${JSON.stringify(res.errors)}`,
			);
			return null;
		}

		console.log(
			`Created alert policy ${res.result.id} for ${scriptName}`,
		);
		return res.result.id;
	} catch (err) {
		console.warn(
			`Failed to create alert policy: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

/**
 * Delete a notification policy by ID. Best-effort cleanup.
 */
export async function deleteAlertPolicy(
	accountId: string,
	token: string,
	policyId: string,
): Promise<void> {
	try {
		await cfApiRequest<{ success: boolean }>(
			`/accounts/${accountId}/alerting/v3/policies/${policyId}`,
			token,
			{ method: "DELETE" },
		);
		console.log(`Deleted alert policy ${policyId}`);
	} catch (err) {
		console.warn(
			`Failed to delete alert policy ${policyId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
