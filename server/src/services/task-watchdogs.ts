import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issues,
  issueThreadInteractions,
  issueWatchdogs,
} from "@paperclipai/db";
import type { IssueWatchdog, IssueWatchdogSummary } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { logActivity } from "./activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { issueService } from "./issues.js";

const TASK_WATCHDOG_ORIGIN_KIND = "task_watchdog";
const TASK_WATCHDOG_LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const TASK_WATCHDOG_WAKE_REQUEST_STATUSES = ["queued", "deferred_issue_execution"] as const;
const TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;

type ActorFields = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

export type IssueWatchdogUpsertInput = {
  agentId: string;
  instructions?: string | null;
  actor?: ActorFields;
};

type IssueWatchdogRow = typeof issueWatchdogs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

export type TaskWatchdogClassifierIssue = Pick<
  IssueRow,
  | "id"
  | "companyId"
  | "identifier"
  | "title"
  | "status"
  | "parentId"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "originKind"
  | "updatedAt"
>;

export type TaskWatchdogClassifierPath = {
  companyId: string;
  issueId: string | null;
  agentId?: string | null;
  status: string;
};

export type TaskWatchdogClassifierWaitingPath = {
  companyId: string;
  issueId: string;
  id?: string | null;
  status: string;
};

export type TaskWatchdogClassifierRelation = {
  companyId: string;
  blockerIssueId: string;
  blockedIssueId: string;
};

export type TaskWatchdogClassifierConfig = Pick<
  IssueWatchdogSummary,
  "companyId" | "issueId" | "lastReviewedFingerprint"
>;

export type TaskWatchdogStoppedLeaf = {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockerIssueIds: string[];
  pendingInteractionIds: string[];
  pendingApprovalIds: string[];
  updatedAt: string;
};

export type TaskWatchdogClassifierResult =
  | {
    state: "not_applicable";
    reason: string;
    includedIssueIds: string[];
  }
  | {
    state: "live";
    reason: string;
    includedIssueIds: string[];
    liveIssueIds: string[];
  }
  | {
    state: "already_reviewed";
    reason: string;
    includedIssueIds: string[];
    stopFingerprint: string;
    stoppedLeaves: TaskWatchdogStoppedLeaf[];
  }
  | {
    state: "stopped";
    reason: string;
    includedIssueIds: string[];
    stopFingerprint: string;
    stoppedLeaves: TaskWatchdogStoppedLeaf[];
  };

export type TaskWatchdogClassifierInput = {
  watchdog: TaskWatchdogClassifierConfig;
  issues: TaskWatchdogClassifierIssue[];
  activeRuns?: TaskWatchdogClassifierPath[];
  queuedWakeRequests?: TaskWatchdogClassifierPath[];
  blockers?: TaskWatchdogClassifierRelation[];
  pendingInteractions?: TaskWatchdogClassifierWaitingPath[];
  pendingApprovals?: TaskWatchdogClassifierWaitingPath[];
};

type TaskWatchdogWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type TaskWatchdogWakeup = (
  agentId: string,
  opts?: TaskWatchdogWakeupOptions,
) => Promise<{ id: string } | null>;

export type TaskWatchdogServiceDeps = {
  enqueueWakeup?: TaskWatchdogWakeup;
};

function normalizeInstructions(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function summarizeIssueWatchdog(row: IssueWatchdogRow): IssueWatchdogSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    watchdogAgentId: row.watchdogAgentId,
    instructions: row.instructions,
    status: row.status as IssueWatchdogSummary["status"],
    watchdogIssueId: row.watchdogIssueId,
    lastObservedFingerprint: row.lastObservedFingerprint,
    lastReviewedFingerprint: row.lastReviewedFingerprint,
    lastTriggeredAt: row.lastTriggeredAt,
    lastCompletedAt: row.lastCompletedAt,
    triggerCount: row.triggerCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toIssueWatchdog(row: IssueWatchdogRow): IssueWatchdog {
  return {
    ...summarizeIssueWatchdog(row),
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    updatedByRunId: row.updatedByRunId,
  };
}

function issueUpdatedAtIso(issue: Pick<TaskWatchdogClassifierIssue, "updatedAt">) {
  return issue.updatedAt instanceof Date
    ? issue.updatedAt.toISOString()
    : new Date(String(issue.updatedAt)).toISOString();
}

function pathIssueIds(paths: TaskWatchdogClassifierPath[] | undefined, companyId: string) {
  return new Set(
    (paths ?? [])
      .filter((path) => path.companyId === companyId && typeof path.issueId === "string" && path.issueId.length > 0)
      .map((path) => path.issueId as string),
  );
}

function waitingPathIds(
  paths: TaskWatchdogClassifierWaitingPath[] | undefined,
  companyId: string,
  issueId: string,
) {
  return (paths ?? [])
    .filter((path) => path.companyId === companyId && path.issueId === issueId)
    .map((path) => path.id ?? `${path.status}:${path.issueId}`)
    .sort();
}

function stableStopFingerprint(input: {
  companyId: string;
  watchedIssueId: string;
  leaves: TaskWatchdogStoppedLeaf[];
}) {
  const payload = JSON.stringify({
    version: 1,
    companyId: input.companyId,
    watchedIssueId: input.watchedIssueId,
    leaves: input.leaves,
  });
  return `task_watchdog_stop:${createHash("sha256").update(payload).digest("hex")}`;
}

export function classifyTaskWatchdogSubtree(input: TaskWatchdogClassifierInput): TaskWatchdogClassifierResult {
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const root = issuesById.get(input.watchdog.issueId);
  if (!root || root.companyId !== input.watchdog.companyId) {
    return { state: "not_applicable", reason: "Watched issue is missing.", includedIssueIds: [] };
  }
  if (root.originKind === TASK_WATCHDOG_ORIGIN_KIND) {
    return {
      state: "not_applicable",
      reason: "Task watchdog origin issues cannot themselves be watched.",
      includedIssueIds: [],
    };
  }

  const childrenByParentId = new Map<string, TaskWatchdogClassifierIssue[]>();
  for (const issue of input.issues) {
    if (issue.companyId !== input.watchdog.companyId || !issue.parentId) continue;
    const list = childrenByParentId.get(issue.parentId) ?? [];
    list.push(issue);
    childrenByParentId.set(issue.parentId, list);
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) => left.id.localeCompare(right.id));
  }

  const included: TaskWatchdogClassifierIssue[] = [];
  const visit = (issue: TaskWatchdogClassifierIssue) => {
    if (issue.originKind === TASK_WATCHDOG_ORIGIN_KIND) return;
    included.push(issue);
    for (const child of childrenByParentId.get(issue.id) ?? []) {
      visit(child);
    }
  };
  visit(root);
  if (included.length === 0) {
    return { state: "not_applicable", reason: "Watched subtree has no non-watchdog issues.", includedIssueIds: [] };
  }

  const includedIds = included.map((issue) => issue.id);
  const includedIdSet = new Set(includedIds);
  const liveIssueIds = [
    ...pathIssueIds(input.activeRuns, input.watchdog.companyId),
    ...pathIssueIds(input.queuedWakeRequests, input.watchdog.companyId),
  ].filter((issueId) => includedIdSet.has(issueId));
  const uniqueLiveIssueIds = [...new Set(liveIssueIds)].sort();
  if (uniqueLiveIssueIds.length > 0) {
    return {
      state: "live",
      reason: "At least one issue in the watched subtree has a live run, queued wake, or scheduled retry.",
      includedIssueIds: includedIds,
      liveIssueIds: uniqueLiveIssueIds,
    };
  }

  const includedChildrenByParentId = new Map<string, string[]>();
  for (const issue of included) {
    if (!issue.parentId || !includedIdSet.has(issue.parentId)) continue;
    const list = includedChildrenByParentId.get(issue.parentId) ?? [];
    list.push(issue.id);
    includedChildrenByParentId.set(issue.parentId, list);
  }
  const blockersByIssueId = new Map<string, string[]>();
  for (const relation of input.blockers ?? []) {
    if (relation.companyId !== input.watchdog.companyId) continue;
    if (!includedIdSet.has(relation.blockedIssueId)) continue;
    const list = blockersByIssueId.get(relation.blockedIssueId) ?? [];
    list.push(relation.blockerIssueId);
    blockersByIssueId.set(relation.blockedIssueId, list);
  }

  const leaves = included
    .filter((issue) => (includedChildrenByParentId.get(issue.id) ?? []).length === 0)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((issue) => ({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      blockerIssueIds: [...new Set(blockersByIssueId.get(issue.id) ?? [])].sort(),
      pendingInteractionIds: waitingPathIds(input.pendingInteractions, input.watchdog.companyId, issue.id),
      pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
      updatedAt: issueUpdatedAtIso(issue),
    }));
  const stopFingerprint = stableStopFingerprint({
    companyId: input.watchdog.companyId,
    watchedIssueId: input.watchdog.issueId,
    leaves,
  });

  if (input.watchdog.lastReviewedFingerprint === stopFingerprint) {
    return {
      state: "already_reviewed",
      reason: "The current stopped subtree fingerprint was already reviewed by the watchdog.",
      includedIssueIds: includedIds,
      stopFingerprint,
      stoppedLeaves: leaves,
    };
  }

  return {
    state: "stopped",
    reason: "No issue in the watched subtree has a live execution path.",
    includedIssueIds: includedIds,
    stopFingerprint,
    stoppedLeaves: leaves,
  };
}

async function assertWatchedIssue(dbOrTx: any, companyId: string, issueId: string) {
  const issue = await dbOrTx
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

async function assertWatchdogAgentInvokable(dbOrTx: any, companyId: string, agentId: string) {
  const agent = await dbOrTx
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows: Array<{
      id: string;
      companyId: string;
      name: string;
      reportsTo: string | null;
      status: string;
    }>) => rows[0] ?? null);
  if (!agent || agent.companyId !== companyId) {
    throw notFound("Watchdog agent not found");
  }
  const invokability = await evaluateAgentInvokabilityFromDb(dbOrTx as Db, agent);
  if (!invokability.invokable) {
    throw conflict("Cannot assign watchdog to an agent that is not invokable", invokability);
  }
  return agent;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nested = parseObject(parsed._paperclipWakeContext);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(parsed.taskId) ??
    readNonEmptyString(nested.issueId) ??
    readNonEmptyString(nested.taskId);
}

function taskWatchdogOriginFingerprint(companyId: string, watchedIssueId: string) {
  return `task_watchdog:${companyId}:${watchedIssueId}`;
}

function taskWatchdogWakeIdempotencyKey(watchdogId: string, stopFingerprint: string) {
  return `task_watchdog:${watchdogId}:${stopFingerprint}`;
}

function buildStoppedFingerprintComment(input: {
  sourceIssue: Pick<IssueRow, "identifier" | "id">;
  stopFingerprint: string;
  stoppedLeaves: TaskWatchdogStoppedLeaf[];
  resumed: boolean;
}) {
  const leafLines = input.stoppedLeaves.slice(0, 12).map((leaf) =>
    `- ${leaf.identifier ?? leaf.issueId}: ${leaf.status} (updated ${leaf.updatedAt})`
  );
  const more = input.stoppedLeaves.length > leafLines.length
    ? `\n- ...and ${input.stoppedLeaves.length - leafLines.length} more stopped leaves`
    : "";
  return [
    input.resumed ? "Task watchdog resumed for stopped subtree." : "Task watchdog started for stopped subtree.",
    "",
    `Watched issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
    `Stopped fingerprint: \`${input.stopFingerprint}\``,
    "",
    "Stopped leaves:",
    ...(leafLines.length > 0 ? leafLines : ["- No leaf issues found."]),
    more,
  ].filter((line) => line !== "").join("\n");
}

function stoppedFingerprintMetadata(input: {
  sourceIssueId: string;
  stopFingerprint: string;
  resumed: boolean;
}) {
  return {
    version: 1 as const,
    sections: [
      {
        title: "Task Watchdog",
        rows: [
          { type: "text" as const, label: "Watched issue", text: input.sourceIssueId },
          { type: "text" as const, label: "Stopped fingerprint", text: input.stopFingerprint },
          { type: "text" as const, label: "Resume intent", text: input.resumed ? "true" : "false" },
        ],
      },
    ],
  };
}

function watchdogWakeContext(input: {
  watchdog: IssueWatchdogRow;
  watchdogIssue: IssueRow;
  sourceIssue: IssueRow;
  classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>;
}) {
  return {
    issueId: input.watchdogIssue.id,
    taskId: input.watchdogIssue.id,
    wakeReason: "task_watchdog_stopped_subtree",
    source: TASK_WATCHDOG_ORIGIN_KIND,
    taskWatchdog: true,
    watchdogId: input.watchdog.id,
    watchedIssueId: input.sourceIssue.id,
    watchedIssueIdentifier: input.sourceIssue.identifier,
    stopFingerprint: input.classification.stopFingerprint,
    stoppedLeaves: input.classification.stoppedLeaves,
    customInstructions: input.watchdog.instructions,
    resumeIntent: true,
    followUpRequested: true,
  };
}

function isTerminalIssueStatus(status: string) {
  return TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES.includes(
    status as (typeof TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES)[number],
  );
}

function isActiveTaskWatchdogUniqueConflict(error: unknown) {
  const candidate = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string; message?: string };
    message?: string;
  } | null;
  const code = candidate?.code ?? candidate?.cause?.code;
  const constraint = candidate?.constraint ?? candidate?.cause?.constraint;
  const message = candidate?.message ?? candidate?.cause?.message ?? "";
  return (code === "23505" || message.includes("duplicate key value violates unique constraint")) &&
    (constraint === "issues_active_task_watchdog_uq" || message.includes("issues_active_task_watchdog_uq"));
}

export async function upsertIssueWatchdogForIssue(
  dbOrTx: any,
  companyId: string,
  issueId: string,
  input: IssueWatchdogUpsertInput,
): Promise<{ watchdog: IssueWatchdog; created: boolean }> {
  await assertWatchedIssue(dbOrTx, companyId, issueId);
  await assertWatchdogAgentInvokable(dbOrTx, companyId, input.agentId);

  const now = new Date();
  const existing = await dbOrTx
    .select()
    .from(issueWatchdogs)
    .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
    .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);

  if (existing) {
    const [updated] = await dbOrTx
      .update(issueWatchdogs)
      .set({
        watchdogAgentId: input.agentId,
        instructions: normalizeInstructions(input.instructions),
        status: "active",
        updatedByAgentId: input.actor?.agentId ?? null,
        updatedByUserId: input.actor?.userId ?? null,
        updatedByRunId: input.actor?.runId ?? null,
        updatedAt: now,
      })
      .where(eq(issueWatchdogs.id, existing.id))
      .returning();
    return { watchdog: toIssueWatchdog(updated), created: false };
  }

  const [created] = await dbOrTx
    .insert(issueWatchdogs)
    .values({
      companyId,
      issueId,
      watchdogAgentId: input.agentId,
      instructions: normalizeInstructions(input.instructions),
      status: "active",
      createdByAgentId: input.actor?.agentId ?? null,
      createdByUserId: input.actor?.userId ?? null,
      createdByRunId: input.actor?.runId ?? null,
      updatedByAgentId: input.actor?.agentId ?? null,
      updatedByUserId: input.actor?.userId ?? null,
      updatedByRunId: input.actor?.runId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { watchdog: toIssueWatchdog(created), created: true };
}

export function taskWatchdogService(db: Db, deps: TaskWatchdogServiceDeps = {}) {
  const issuesSvc = issueService(db);

  async function collectClassifierInput(companyId: string, watchdog: IssueWatchdogRow) {
    const [
      issueRows,
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      blockerRows,
      interactionRows,
      approvalRows,
    ] = await Promise.all([
      db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          parentId: issues.parentId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          originKind: issues.originKind,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt))),
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
        )),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
        )),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [...TASK_WATCHDOG_WAKE_REQUEST_STATUSES]),
        )),
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"))),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          id: issueThreadInteractions.id,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.status, "pending"))),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          id: approvals.id,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, companyId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        )),
    ]);

    return {
      watchdog: summarizeIssueWatchdog(watchdog),
      issues: issueRows,
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot),
      })).concat(activeIssueRunRows),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      blockers: blockerRows,
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
    } satisfies TaskWatchdogClassifierInput;
  }

  async function findTaskWatchdogIssue(companyId: string, watchedIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, TASK_WATCHDOG_ORIGIN_KIND),
        eq(issues.originId, watchedIssueId),
        isNull(issues.hiddenAt),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasLivePathForIssue(companyId: string, issueId: string) {
    const [run, issueRun, wake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
          sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
            OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId})`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.id, issueId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [...TASK_WATCHDOG_WAKE_REQUEST_STATUSES]),
          sql`(${agentWakeupRequests.payload}->>'issueId' = ${issueId}
            OR ${agentWakeupRequests.payload}->>'taskId' = ${issueId}
            OR ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId' = ${issueId}
            OR ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId' = ${issueId})`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(run || issueRun || wake);
  }

  async function markTerminalWatchdogIssueReviewed(watchdog: IssueWatchdogRow) {
    if (!watchdog.watchdogIssueId || !watchdog.lastObservedFingerprint) return watchdog;
    if (watchdog.lastReviewedFingerprint === watchdog.lastObservedFingerprint) return watchdog;
    const watchdogIssue = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, watchdog.companyId), eq(issues.id, watchdog.watchdogIssueId)))
      .then((rows) => rows[0] ?? null);
    if (!watchdogIssue || !isTerminalIssueStatus(watchdogIssue.status)) return watchdog;
    const [updated] = await db
      .update(issueWatchdogs)
      .set({
        lastReviewedFingerprint: watchdog.lastObservedFingerprint,
        lastCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issueWatchdogs.id, watchdog.id))
      .returning();
    return updated ?? watchdog;
  }

  async function ensureReusableWatchdogIssue(input: {
    watchdog: IssueWatchdogRow;
    sourceIssue: IssueRow;
    classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>;
    runId?: string | null;
  }) {
    const existing = input.watchdog.watchdogIssueId
      ? await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, input.watchdog.companyId),
          eq(issues.id, input.watchdog.watchdogIssueId),
          isNull(issues.hiddenAt),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    const fallback = existing ?? await findTaskWatchdogIssue(input.watchdog.companyId, input.sourceIssue.id);

    if (fallback) {
      const shouldReopen = isTerminalIssueStatus(fallback.status) || fallback.status === "backlog";
      const watchdogIssue = shouldReopen
        ? await issuesSvc.update(fallback.id, {
          status: "todo",
          assigneeAgentId: input.watchdog.watchdogAgentId,
          parentId: input.sourceIssue.id,
          projectId: input.sourceIssue.projectId,
          goalId: input.sourceIssue.goalId,
          billingCode: input.sourceIssue.billingCode,
        }) ?? fallback
        : fallback;
      await issuesSvc.addComment(
        watchdogIssue.id,
        buildStoppedFingerprintComment({
          sourceIssue: input.sourceIssue,
          stopFingerprint: input.classification.stopFingerprint,
          stoppedLeaves: input.classification.stoppedLeaves,
          resumed: true,
        }),
        { runId: input.runId ?? null },
        {
          authorType: "system",
          metadata: stoppedFingerprintMetadata({
            sourceIssueId: input.sourceIssue.id,
            stopFingerprint: input.classification.stopFingerprint,
            resumed: true,
          }),
        },
      );
      return watchdogIssue;
    }

    const created = await issuesSvc.create(input.sourceIssue.companyId, {
        title: `Watchdog review for ${input.sourceIssue.identifier ?? input.sourceIssue.title}`,
        description: [
          "Task watchdog review issue.",
          "",
          `Watched issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
          `Stopped fingerprint: ${input.classification.stopFingerprint}`,
          "",
          "The watchdog agent should verify the stopped subtree and either confirm the disposition or restore a valid live path.",
        ].join("\n"),
        status: "todo",
        priority: input.sourceIssue.priority,
        parentId: input.sourceIssue.id,
        projectId: input.sourceIssue.projectId,
        goalId: input.sourceIssue.goalId,
        assigneeAgentId: input.watchdog.watchdogAgentId,
        originKind: TASK_WATCHDOG_ORIGIN_KIND,
        originId: input.sourceIssue.id,
        originFingerprint: taskWatchdogOriginFingerprint(input.sourceIssue.companyId, input.sourceIssue.id),
        billingCode: input.sourceIssue.billingCode,
        inheritExecutionWorkspaceFromIssueId: input.sourceIssue.id,
      })
      .catch(async (error: unknown) => {
        if (!isActiveTaskWatchdogUniqueConflict(error)) throw error;
        const winner = await findTaskWatchdogIssue(input.watchdog.companyId, input.sourceIssue.id);
        if (!winner) throw error;
        return winner;
      });
    await issuesSvc.addComment(
      created.id,
      buildStoppedFingerprintComment({
        sourceIssue: input.sourceIssue,
        stopFingerprint: input.classification.stopFingerprint,
        stoppedLeaves: input.classification.stoppedLeaves,
        resumed: false,
      }),
      { runId: input.runId ?? null },
      {
        authorType: "system",
        metadata: stoppedFingerprintMetadata({
          sourceIssueId: input.sourceIssue.id,
          stopFingerprint: input.classification.stopFingerprint,
          resumed: false,
        }),
      },
    );
    return created;
  }

  async function evaluateWatchdog(row: IssueWatchdogRow, opts: { runId?: string | null } = {}) {
    const watchdog = await markTerminalWatchdogIssueReviewed(row);
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, watchdog.companyId), eq(issues.id, watchdog.issueId), isNull(issues.hiddenAt)))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue || sourceIssue.originKind === TASK_WATCHDOG_ORIGIN_KIND) {
      return { state: "skipped" as const, reason: "watched_issue_not_applicable" };
    }

    const input = await collectClassifierInput(watchdog.companyId, watchdog);
    const classification = classifyTaskWatchdogSubtree(input);
    if (classification.state !== "stopped") {
      return { state: classification.state, reason: classification.reason, classification };
    }

    const existingWatchdogIssueId = watchdog.watchdogIssueId ?? (await findTaskWatchdogIssue(
      watchdog.companyId,
      sourceIssue.id,
    ))?.id ?? null;
    if (existingWatchdogIssueId && await hasLivePathForIssue(watchdog.companyId, existingWatchdogIssueId)) {
      await db
        .update(issueWatchdogs)
        .set({
          watchdogIssueId: existingWatchdogIssueId,
          lastObservedFingerprint: classification.stopFingerprint,
          updatedAt: new Date(),
        })
        .where(eq(issueWatchdogs.id, watchdog.id));
      return { state: "watchdog_live" as const, classification, watchdogIssueId: existingWatchdogIssueId };
    }

    const watchdogIssue = await ensureReusableWatchdogIssue({
      watchdog,
      sourceIssue,
      classification,
      runId: opts.runId ?? null,
    });
    const now = new Date();
    await db
      .update(issueWatchdogs)
      .set({
        watchdogIssueId: watchdogIssue.id,
        lastObservedFingerprint: classification.stopFingerprint,
        lastTriggeredAt: now,
        triggerCount: sql`${issueWatchdogs.triggerCount} + 1`,
        updatedAt: now,
      })
      .where(eq(issueWatchdogs.id, watchdog.id));

    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: watchdog.watchdogAgentId,
      runId: opts.runId ?? null,
      action: "issue.task_watchdog_triggered",
      entityType: "issue",
      entityId: sourceIssue.id,
      details: {
        source: "task_watchdogs.evaluate",
        watchdogId: watchdog.id,
        watchdogIssueId: watchdogIssue.id,
        stopFingerprint: classification.stopFingerprint,
        stoppedLeaves: classification.stoppedLeaves,
      },
    });

    const context = watchdogWakeContext({
      watchdog,
      watchdogIssue,
      sourceIssue,
      classification,
    });
    const wake = deps.enqueueWakeup
      ? await deps.enqueueWakeup(watchdog.watchdogAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "task_watchdog_stopped_subtree",
        payload: context,
        contextSnapshot: context,
        idempotencyKey: taskWatchdogWakeIdempotencyKey(watchdog.id, classification.stopFingerprint),
        requestedByActorType: "system",
        requestedByActorId: null,
      })
      : null;

    return {
      state: "triggered" as const,
      classification,
      watchdogIssueId: watchdogIssue.id,
      wakeupRunId: wake?.id ?? null,
    };
  }

  async function listActiveWatchdogsForCompany(companyId?: string | null) {
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.status, "active"),
        ...(companyId ? [eq(issueWatchdogs.companyId, companyId)] : []),
      ));
  }

  async function activeWatchdogsForIssueAndAncestors(companyId: string, issueId: string) {
    const issueRows = await db
      .select({ id: issues.id, parentId: issues.parentId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)));
    const byId = new Map(issueRows.map((issue) => [issue.id, issue]));
    const ancestorIds: string[] = [];
    const seen = new Set<string>();
    let current = byId.get(issueId) ?? null;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      ancestorIds.push(current.id);
      current = current.parentId ? byId.get(current.parentId) ?? null : null;
    }
    if (ancestorIds.length === 0) return [];
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, companyId),
        eq(issueWatchdogs.status, "active"),
        inArray(issueWatchdogs.issueId, ancestorIds),
      ));
  }

  return {
    getActiveForIssue: async (companyId: string, issueId: string): Promise<IssueWatchdog | null> => {
      const row = await db
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          eq(issueWatchdogs.issueId, issueId),
          eq(issueWatchdogs.status, "active"),
        ))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWatchdog(row) : null;
    },

    listActiveSummariesForIssues: async (
      companyId: string,
      issueIds: string[],
      dbOrTx: any = db,
    ): Promise<Map<string, IssueWatchdogSummary>> => {
      if (issueIds.length === 0) return new Map();
      const rows = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          inArray(issueWatchdogs.issueId, [...new Set(issueIds)]),
          eq(issueWatchdogs.status, "active"),
        ));
      return new Map(rows.map((row: IssueWatchdogRow) => [row.issueId, summarizeIssueWatchdog(row)]));
    },

    upsertForIssue: async (
      companyId: string,
      issueId: string,
      input: IssueWatchdogUpsertInput,
    ): Promise<{ watchdog: IssueWatchdog; created: boolean }> => {
      return upsertIssueWatchdogForIssue(db, companyId, issueId, input);
    },

    disableForIssue: async (
      companyId: string,
      issueId: string,
      actor: ActorFields = {},
    ): Promise<IssueWatchdog | null> => {
      await assertWatchedIssue(db, companyId, issueId);
      const existing = await db
        .select()
        .from(issueWatchdogs)
        .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
        .then((rows) => rows[0] ?? null);
      if (!existing || existing.status === "disabled") return null;
      const [updated] = await db
        .update(issueWatchdogs)
        .set({
          status: "disabled",
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedByRunId: actor.runId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(issueWatchdogs.id, existing.id))
        .returning();
      return toIssueWatchdog(updated);
    },

    reconcileTaskWatchdogs: async (opts: { companyId?: string | null; runId?: string | null } = {}) => {
      const rows = await listActiveWatchdogsForCompany(opts.companyId ?? null);
      const result = {
        checked: 0,
        triggered: 0,
        live: 0,
        alreadyReviewed: 0,
        skipped: 0,
        watchdogIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.watchdogIssueIds.push(evaluated.watchdogIssueId);
        } else if (evaluated.state === "live" || evaluated.state === "watchdog_live") {
          result.live += 1;
        } else if (evaluated.state === "already_reviewed") {
          result.alreadyReviewed += 1;
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },

    reconcileForIssueAndAncestors: async (
      companyId: string,
      issueId: string,
      opts: { runId?: string | null } = {},
    ) => {
      const rows = await activeWatchdogsForIssueAndAncestors(companyId, issueId);
      const result = {
        checked: 0,
        triggered: 0,
        skipped: 0,
        watchdogIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.watchdogIssueIds.push(evaluated.watchdogIssueId);
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },
  };
}
