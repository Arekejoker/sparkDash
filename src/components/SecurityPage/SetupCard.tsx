import type { ReactNode } from "react";
import type { VulnHuntSetup, VulnHuntStatus } from "../../api/types";
import { CheckIcon, RotateIcon, ShieldIcon, XIcon } from "../ui/icons";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { CommandBlock, Notice } from "./parts";
import { setupProblems } from "./securityLogic";

interface SetupCardProps {
  unitName: string;
  setup: VulnHuntSetup | null;
  setupError: string | null;
  status: VulnHuntStatus | null;
  loading: boolean;
  error: string | null;
  onRecheck: () => void;
}

function Row({ ok, label, detail }: { ok: boolean; label: string; detail?: ReactNode }) {
  return (
    <li className={`sec-check${ok ? " is-ok" : " is-bad"}`}>
      {ok ? <CheckIcon className="sec-check__icon" /> : <XIcon className="sec-check__icon" />}
      <span className="sec-check__label">{label}</span>
      {detail ? <span className="sec-check__detail">{detail}</span> : null}
    </li>
  );
}

function harnessDetail(status: VulnHuntStatus): string {
  const h = status.hostCommand;
  const where = h.source === "env" ? "from the unit's environment" : h.source === "file" ? "from the command file" : "";
  if (h.program) return [h.program, where].filter(Boolean).join(" ");
  return where;
}

/** What the unit has and what is still missing, with the copyable setup steps when it is not ready. */
export function SetupCard({ unitName, setup, setupError, status, loading, error, onRecheck }: SetupCardProps) {
  const recheck = (
    <button type="button" className="btn btn--sm btn--ghost" onClick={onRecheck} disabled={loading}>
      <RotateIcon className={`h-3.5 w-3.5${loading ? " sec-spin" : ""}`} /> {loading ? "Checking" : "Check again"}
    </button>
  );
  const badge = !status ? null : <Tag tone={status.ready ? "good" : "warn"}>{status.ready ? "Ready" : "Setup needed"}</Tag>;

  let body: ReactNode;
  if (!status) {
    body = error ? (
      <Notice tone="bad" title="Could not check this unit" actions={recheck}>
        {error}
      </Notice>
    ) : (
      <p className="sec-muted">Checking {unitName}…</p>
    );
  } else if (!status.reachable) {
    body = (
      <Notice tone="warn" title={`${unitName} could not be reached`} actions={recheck}>
        {status.error ?? "The unit did not answer. Check that it is online and that the dashboard can log in over SSH."}
      </Notice>
    );
  } else {
    const problems = setupProblems(status);
    body = (
      <>
        <ul className="sec-checks" aria-label="Setup checklist">
          <Row ok={status.installed} label="VulnHunter installed" detail={status.installed ? status.path : "not found"} />
          <Row ok={status.git} label="git available" />
          <Row ok={status.setsid} label="setsid available" />
          <Row
            ok={status.hostCommand.configured}
            label="Harness command configured"
            detail={status.hostCommand.configured ? harnessDetail(status) : status.hostCommand.source === "unsafe" ? "file is not safe to use" : "not configured"}
          />
        </ul>
        {status.ready ? (
          <p className="sec-muted">
            Scans run on {unitName} as the user the dashboard connects with. The harness command is read on the unit and is never shown here.
          </p>
        ) : (
          <>
            <Notice tone="warn" title="This unit is not ready to scan yet">
              <ul className="sec-problems">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
            {setupError ? (
              <Notice tone="bad" title="Could not load the setup steps">
                {setupError}
              </Notice>
            ) : setup ? (
              <div className="sec-steps">
                <p className="sec-muted">
                  Run these on {unitName}, in order. VulnHunter comes from{" "}
                  <a href={setup.repository} target="_blank" rel="noopener noreferrer">
                    {setup.repository.replace(/^https:\/\//, "")}
                  </a>
                  ; replace the placeholders in angle brackets with your agent harness settings.
                </p>
                <ol className="sec-steps__list">
                  {setup.steps.map((step, i) => (
                    <li key={step}>
                      <CommandBlock label={`Step ${i + 1}`} command={step} />
                    </li>
                  ))}
                </ol>
                <p className="sec-muted">
                  The harness command (a headless one-shot of your agent harness) is read from <code>{setup.hostCommandFile}</code> on the unit,
                  or from the <code>VULNHUNT_HOST_CMD</code> environment variable. Keep that file private (mode 600). The dashboard only
                  shows the program name, never the command line.
                </p>
              </div>
            ) : (
              <p className="sec-muted">Loading the setup steps…</p>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <Panel
      title={`VulnHunter on ${unitName}`}
      icon={<ShieldIcon className="h-4 w-4" />}
      actions={
        <>
          {badge}
          {status && status.reachable ? recheck : null}
        </>
      }
    >
      <div className="sec-stack">{body}</div>
    </Panel>
  );
}
