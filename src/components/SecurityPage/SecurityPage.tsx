import { useCallback, useEffect, useRef, useState } from "react";
import type { SparkSnapshot, VulnHuntRun } from "../../api/types";
import { SparkChips } from "../bench/SparkChips";
import { History } from "./History";
import { LiveScan } from "./LiveScan";
import { Notice } from "./parts";
import { ReportPanel } from "./ReportView";
import { ScanForm } from "./ScanForm";
import { SetupCard } from "./SetupCard";
import { useSecuritySpark, useVulnHuntReport, useVulnHuntRunner, useVulnHuntSetup, useVulnHuntStatus } from "./hooks";
import { FALLBACK_LIMITS, isLive } from "./securityLogic";
import "../../styles/security.css";

interface SecurityPageProps {
  sparks: SparkSnapshot[];
  onSelectSpark?: (id: string) => void;
}

/** Everything for one unit. Keyed by unit id, so switching units starts from a clean slate. */
function Workspace({ spark }: { spark: SparkSnapshot }) {
  const { setup, error: setupError } = useVulnHuntSetup();
  const status = useVulnHuntStatus(spark.id);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [reportVersion, setReportVersion] = useState(0);
  const reportRef = useRef<HTMLDivElement>(null);

  const onSettled = useCallback((run: VulnHuntRun) => {
    // A finished scan opens its report straight away (the server captures it on demand).
    if (run.status === "completed") {
      setViewedId(run.id);
      setReportVersion((v) => v + 1);
    }
  }, []);
  const runner = useVulnHuntRunner(spark.id, onSettled);
  const report = useVulnHuntReport(spark.id, viewedId, reportVersion);
  const viewedRun = runner.runs?.find((r) => r.id === viewedId) ?? report.run ?? null;

  // Bring a report that was just opened into view.
  useEffect(() => {
    if (viewedId) reportRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [viewedId]);

  const followedLive = runner.followed ? isLive(runner.followed.run) : false;
  const anyLive = followedLive || (runner.runs?.some(isLive) ?? false);
  const notReady = !status.status || !status.status.ready;
  const disabledReason = status.loading && !status.status
    ? "Checking the unit…"
    : notReady
      ? "Finish the setup above before starting a scan."
      : anyLive
        ? "A scan is already running on this unit. Wait for it to finish, or stop it."
        : null;

  const openReport = (run: VulnHuntRun) => {
    setViewedId(run.id);
  };

  return (
    <>
      <SetupCard
        unitName={spark.name}
        setup={setup}
        setupError={setupError}
        status={status.status}
        loading={status.loading}
        error={status.error}
        onRecheck={() => void status.reload()}
      />

      <ScanForm
        unitName={spark.name}
        limits={setup?.limits ?? FALLBACK_LIMITS}
        disabledReason={disabledReason}
        error={runner.startError}
        onStart={runner.start}
        onDismissError={runner.clearStartError}
      />

      {runner.actionError ? (
        <Notice
          tone="bad"
          actions={
            <button type="button" className="btn btn--sm" onClick={runner.clearActionError}>
              Dismiss
            </button>
          }
        >
          {runner.actionError}
        </Notice>
      ) : null}

      {runner.followed ? (
        <LiveScan
          followed={runner.followed}
          polling={runner.polling}
          pollError={runner.pollError}
          onStop={() => runner.stop(runner.followed!.run)}
          onStopWatching={() => void runner.stopWatching()}
          onWatch={() => void runner.attach(runner.followed!.run)}
          onRefresh={() => void runner.refresh(runner.followed!.run)}
          onDismiss={runner.unfollow}
          onViewReport={openReport}
        />
      ) : null}

      {viewedId ? (
        <div ref={reportRef}>
          <ReportPanel state={report} run={viewedRun} onClose={() => setViewedId(null)} />
        </div>
      ) : null}

      <History
        runs={runner.runs}
        error={runner.listError}
        followedId={runner.followed?.run.id ?? null}
        viewedId={viewedId}
        onReload={() => void runner.reloadRuns()}
        onOpen={openReport}
        onWatch={(r) => void runner.attach(r)}
        onRefresh={(r) => void runner.refresh(r)}
        onDelete={async (r, force) => {
          const res = await runner.remove(r, force);
          if (res.ok && viewedId === r.id) setViewedId(null);
          return res;
        }}
      />
    </>
  );
}

/** Security scans: VulnHunter run on a unit, with its live output, history and parsed reports. */
export function SecurityPage({ sparks, onSelectSpark }: SecurityPageProps) {
  const { spark, select, eligible } = useSecuritySpark(sparks);
  return (
    <div className="sec">
      <div className="page-head">
        <div>
          <div className="eyebrow">Security</div>
          <h1>Security scans</h1>
          <p className="page-head__sub">
            Run VulnHunter, an agentic source-code security scanner, on one of your units. The scan runs there, its output streams here, and
            the report is kept for later.
          </p>
        </div>
        <div className="page-head__tools">
          {spark && onSelectSpark ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onSelectSpark(spark.id)}>
              Open {spark.name}
            </button>
          ) : null}
        </div>
      </div>

      <div className="bench-runon">
        <span className="eyebrow">Run on</span>
        {eligible.length === 0 ? <span className="bench-runon__none">No online Linux unit available</span> : null}
        <SparkChips sparks={eligible} activeId={spark?.id ?? null} onSelect={select} ariaLabel="Unit to scan on" />
      </div>

      {spark ? (
        <Workspace key={spark.id} spark={spark} />
      ) : (
        <Notice tone="info" title="No unit to scan on">
          Scans run on an online Linux unit (a DGX Spark or a GPU host). Windows units and offline units are not offered.
        </Notice>
      )}
    </div>
  );
}
