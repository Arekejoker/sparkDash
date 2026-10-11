import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachVulnHuntScan,
  cancelVulnHuntWatch,
  deleteVulnHuntScan,
  fetchVulnHuntReport,
  fetchVulnHuntSetup,
  fetchVulnHuntStatus,
  listVulnHuntRuns,
  readVulnHuntStream,
  refreshVulnHuntScan,
  startVulnHuntScan,
  stopVulnHuntScan,
} from "../../api/client";
import {
  VulnHuntApiError,
  type SparkSnapshot,
  type VulnHuntJob,
  type VulnHuntLine,
  type VulnHuntReportBundle,
  type VulnHuntRun,
  type VulnHuntScanRequest,
  type VulnHuntSetup,
  type VulnHuntStatus,
} from "../../api/types";
import { eligibleUnits, isLive } from "./securityLogic";

/** Poll interval while a scan is being followed. Nothing polls otherwise. */
export const POLL_MS = 1500;
const MAX_LINES = 5000;
/** How many polls to wait for the stored run to settle after the job ended (result capture). */
const SETTLE_TRIES = 20;

export const SECURITY_SPARK_KEY = "sparkdash.security.spark";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Merge newly read lines (by sequence number) into the buffer. */
export function mergeLines(prev: VulnHuntLine[], next: VulnHuntLine[], max = MAX_LINES): VulnHuntLine[] {
  if (!next.length) return prev;
  const last = prev.length ? prev[prev.length - 1].seq : 0;
  const fresh = next.filter((l) => l.seq > last);
  if (!fresh.length) return prev;
  const merged = prev.concat(fresh);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

// ── which unit the page acts on ──

function readStored(): string | null {
  try {
    return localStorage.getItem(SECURITY_SPARK_KEY);
  } catch {
    return null;
  }
}

/** The unit scans run on: online Linux units only, remembered across visits, first one by default. */
export function useSecuritySpark(sparks: readonly SparkSnapshot[]) {
  const [stored, setStored] = useState<string | null>(readStored);
  const eligible = useMemo(() => eligibleUnits(sparks), [sparks]);
  const spark = useMemo(() => eligible.find((s) => s.id === stored) ?? eligible[0] ?? null, [eligible, stored]);
  const select = useCallback((id: string) => {
    setStored(id);
    try {
      localStorage.setItem(SECURITY_SPARK_KEY, id);
    } catch {
      /* private mode */
    }
  }, []);
  return { spark, select, eligible };
}

// ── setup text (static) and the unit's readiness ──

let setupPromise: Promise<VulnHuntSetup> | null = null;

export function useVulnHuntSetup() {
  const [setup, setSetup] = useState<VulnHuntSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    setupPromise ??= fetchVulnHuntSetup();
    setupPromise
      .then((s) => !off && (setSetup(s), setError(null)))
      .catch((e) => {
        setupPromise = null;
        if (!off) setError(msg(e));
      });
    return () => {
      off = true;
    };
  }, []);
  return { setup, error };
}

export function useVulnHuntStatus(sparkId: string) {
  const [status, setStatus] = useState<VulnHuntStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const reload = useCallback(async () => {
    const id = ++reqRef.current;
    setLoading(true);
    try {
      const s = await fetchVulnHuntStatus(sparkId);
      if (id === reqRef.current) {
        setStatus(s);
        setError(null);
      }
    } catch (e) {
      if (id === reqRef.current) setError(msg(e));
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [sparkId]);
  useEffect(() => {
    void reload();
    return () => {
      reqRef.current += 1;
    };
  }, [reload]);
  return { status, error, loading, reload };
}

// ── runs: history, the followed run and its live stream ──

export interface Followed {
  run: VulnHuntRun;
  job: VulnHuntJob | null;
  lines: VulnHuntLine[];
  partial: string;
  stage: string | null;
  /** The server has no live job for this run (restart, or finished long ago). */
  noLive: boolean;
}

export function useVulnHuntRunner(sparkId: string, onSettled: (run: VulnHuntRun) => void) {
  const [runs, setRuns] = useState<VulnHuntRun[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [followed, setFollowed] = useState<Followed | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The server's message for the last Start attempt (400 validation, 409 busy). */
  const [startError, setStartError] = useState<string | null>(null);
  const lineRef = useRef(0);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const followId = followed?.run.id ?? null;

  const reloadRuns = useCallback(async () => {
    try {
      const r = await listVulnHuntRuns(sparkId);
      setRuns(r.runs);
      setListError(null);
      return r;
    } catch (e) {
      setListError(msg(e));
      return null;
    }
  }, [sparkId]);

  const follow = useCallback((run: VulnHuntRun) => {
    lineRef.current = 0;
    setPollError(null);
    setFollowed({ run, job: null, lines: [], partial: "", stage: null, noLive: false });
    setPolling(true);
  }, []);

  // First load: history, and pick up whatever is running on this unit.
  useEffect(() => {
    let off = false;
    void (async () => {
      const r = await reloadRuns();
      if (off || !r) return;
      if (r.active) {
        const run = r.runs.find((x) => x.id === r.active?.id);
        if (run) follow(run);
        return;
      }
      // No job in memory (the server restarted, or the page was closed): ask the unit about a scan
      // that is still marked running, and re-attach to it when it is.
      const stale = r.runs.find(isLive);
      if (!stale) return;
      try {
        const fresh = await refreshVulnHuntScan(sparkId, stale.id);
        if (off) return;
        if (fresh.state.state === "running") {
          await attachVulnHuntScan(sparkId, stale.id);
          if (!off) follow(fresh.run ?? stale);
        } else {
          await reloadRuns();
        }
      } catch {
        /* busy, unreachable or gone: the run stays listed with Check status / Watch actions */
      }
    })();
    return () => {
      off = true;
    };
  }, [sparkId, reloadRuns, follow]);

  // Poll the followed run until it is no longer running.
  useEffect(() => {
    if (!followId || !polling) return;
    let off = false;
    let timer: number | undefined;
    let settleTries = 0;
    let fails = 0;
    const finish = (run: VulnHuntRun | null) => {
      setPolling(false);
      void reloadRuns();
      if (run) settledRef.current(run);
    };
    const tick = async () => {
      let next = POLL_MS;
      try {
        const read = await readVulnHuntStream(sparkId, followId, lineRef.current);
        if (off) return;
        fails = 0;
        setPollError(null);
        const live = read.live;
        if (live) lineRef.current = Math.max(lineRef.current, live.nextLine);
        setFollowed((p) =>
          p && p.run.id === followId
            ? {
                run: read.run ?? p.run,
                job: live?.job ?? p.job,
                lines: live ? mergeLines(p.lines, live.lines) : p.lines,
                partial: live?.partial ?? "",
                stage: live?.progress?.stage ?? p.stage,
                noLive: !live,
              }
            : p
        );
        if (!live) {
          // Nobody is watching a scan that is still running: stop polling, the card offers Watch.
          if (read.run && isLive(read.run)) setPolling(false);
          else finish(read.run);
          return;
        }
        if (live.job.status !== "running") {
          // The run record settles shortly after the job ends (result capture).
          settleTries += 1;
          // "completed" can show a moment before the report has been captured.
          const settled = read.run && !isLive(read.run) && (read.run.status !== "completed" || read.run.resultCached || settleTries > 6);
          if (settled || live.job.status === "cancelled" || live.job.status === "detached" || settleTries > SETTLE_TRIES) {
            return finish(read.run);
          }
        }
      } catch (e) {
        if (off) return;
        fails += 1;
        setPollError(msg(e));
        // The run was deleted or replaced under us: retrying cannot bring it back.
        if (e instanceof VulnHuntApiError && e.status === 404) return setPolling(false);
        next = Math.min(6000, POLL_MS * (fails + 1));
      }
      timer = window.setTimeout(tick, next);
    };
    timer = window.setTimeout(tick, 150);
    return () => {
      off = true;
      window.clearTimeout(timer);
    };
  }, [sparkId, followId, polling, reloadRuns]);

  const attempt = useCallback(async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setActionError(msg(e));
      return false;
    }
  }, []);

  const start = useCallback(
    async (req: VulnHuntScanRequest): Promise<boolean> => {
      setActionError(null);
      setStartError(null);
      try {
        const r = await startVulnHuntScan(sparkId, req);
        follow(r.run);
        void reloadRuns();
        return true;
      } catch (e) {
        setStartError(msg(e));
        // Another scan holds the unit: refresh the list so it shows (and can be watched).
        if (e instanceof VulnHuntApiError && e.status === 409) void reloadRuns();
        return false;
      }
    },
    [sparkId, follow, reloadRuns]
  );

  const stop = useCallback((r: VulnHuntRun) => attempt(() => stopVulnHuntScan(sparkId, r.id)), [sparkId, attempt]);

  const stopWatching = useCallback(async () => {
    const ok = await attempt(() => cancelVulnHuntWatch(sparkId));
    if (ok) {
      setPolling(false);
      await reloadRuns();
    }
  }, [sparkId, attempt, reloadRuns]);

  const attach = useCallback(
    async (r: VulnHuntRun) => {
      const ok = await attempt(() => attachVulnHuntScan(sparkId, r.id));
      if (ok) follow(r);
      return ok;
    },
    [sparkId, attempt, follow]
  );

  /** Ask the unit whether a scan has finished. */
  const refresh = useCallback(
    async (r: VulnHuntRun): Promise<VulnHuntRun | null> => {
      let fresh: VulnHuntRun | null = null;
      const ok = await attempt(async () => {
        fresh = (await refreshVulnHuntScan(sparkId, r.id)).run;
      });
      await reloadRuns();
      if (ok && fresh) {
        const next: VulnHuntRun = fresh;
        setFollowed((p) => (p?.run.id === r.id ? { ...p, run: next } : p));
      }
      return ok ? fresh : null;
    },
    [sparkId, attempt, reloadRuns]
  );

  /** Delete a scan; resolves with whether the server wants the caller to confirm a forced delete. */
  const remove = useCallback(
    async (r: VulnHuntRun, force = false): Promise<{ ok: boolean; canForce: boolean }> => {
      setActionError(null);
      try {
        await deleteVulnHuntScan(sparkId, r.id, force);
        setFollowed((p) => (p?.run.id === r.id ? null : p));
        await reloadRuns();
        return { ok: true, canForce: false };
      } catch (e) {
        setActionError(msg(e));
        return { ok: false, canForce: e instanceof VulnHuntApiError && e.canForce };
      }
    },
    [sparkId, reloadRuns]
  );

  return {
    runs,
    listError,
    followed,
    polling,
    pollError,
    actionError,
    startError,
    reloadRuns,
    follow,
    unfollow: () => setFollowed(null),
    start,
    stop,
    stopWatching,
    attach,
    refresh,
    remove,
    clearStartError: () => setStartError(null),
    clearActionError: () => setActionError(null),
  };
}

// ── one run's stored report ──

export interface ReportState {
  loading: boolean;
  error: string | null;
  report: VulnHuntReportBundle | null;
  run: VulnHuntRun | null;
}

/** `version` changes when the stored report may have changed (a scan settled), so it is read again. */
export function useVulnHuntReport(sparkId: string, runId: string | null, version = 0): ReportState {
  const [state, setState] = useState<ReportState & { forId: string | null }>({ loading: false, error: null, report: null, run: null, forId: null });
  useEffect(() => {
    if (!runId) {
      setState({ loading: false, error: null, report: null, run: null, forId: null });
      return;
    }
    let off = false;
    setState({ loading: true, error: null, report: null, run: null, forId: runId });
    fetchVulnHuntReport(sparkId, runId)
      .then((r) => !off && setState({ loading: false, error: null, report: r.report, run: r.run, forId: runId }))
      .catch((e) => !off && setState({ loading: false, error: msg(e), report: null, run: null, forId: runId }));
    return () => {
      off = true;
    };
  }, [sparkId, runId, version]);
  // Until the effect has switched to a new run, never hand out the previous run's report.
  if (!runId || state.forId === runId) return state;
  return { loading: true, error: null, report: null, run: null };
}
