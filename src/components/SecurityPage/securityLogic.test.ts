import { describe, expect, it } from "vitest";
import { makeSpark } from "../../testing/fixtures";
import type { VulnHuntFinding } from "../../api/types";
import {
  FALLBACK_LIMITS,
  checkScanForm,
  countFindings,
  eligibleUnits,
  initialForm,
  isLive,
  severityRank,
  severityTone,
  sortFindings,
  sourceHint,
  stageLabel,
  statusTone,
  summarizeCounts,
  seriousCount,
  type ScanFormState,
} from "./securityLogic";
import { mergeLines } from "./hooks";

const finding = (id: string, severity: VulnHuntFinding["severity"]): VulnHuntFinding => ({
  id,
  title: `Finding ${id}`,
  cwe: null,
  severity,
  runtime: null,
  exploitTest: null,
  measuredImpact: null,
  status: null,
});

const valid = (over: Partial<ScanFormState> = {}): ScanFormState => ({
  ...initialForm(FALLBACK_LIMITS),
  value: "https://github.com/org/repo",
  authorized: true,
  ...over,
});

describe("severity helpers", () => {
  it("ranks most serious first and unrated last", () => {
    expect(["Low", "High+", null, "Medium", "High", "Informational"].map((s) => severityRank(s as never))).toEqual([3, 0, 5, 2, 1, 4]);
  });

  it("maps severities to tag tones", () => {
    expect(severityTone("High+")).toBe("bad");
    expect(severityTone("High")).toBe("bad");
    expect(severityTone("Medium")).toBe("warn");
    expect(severityTone("Low")).toBe("info");
    expect(severityTone("Informational")).toBe("neutral");
    expect(severityTone(null)).toBe("neutral");
  });

  it("sorts findings by severity, stably, without touching the input", () => {
    const input = [finding("a", "Low"), finding("b", null), finding("c", "High"), finding("d", "Low"), finding("e", "High+")];
    const desc = sortFindings(input).map((f) => f.id);
    expect(desc).toEqual(["e", "c", "a", "d", "b"]);
    expect(sortFindings(input, "asc").map((f) => f.id)).toEqual(["b", "a", "d", "c", "e"]);
    expect(input.map((f) => f.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("counts findings per severity and summarizes them", () => {
    const counts = countFindings([finding("1", "High"), finding("2", "High"), finding("3", "Low"), finding("4", null)]);
    expect(counts).toEqual({ "High+": 0, High: 2, Medium: 0, Low: 1, Informational: 0, unrated: 1 });
    expect(seriousCount(counts)).toBe(2);
    expect(summarizeCounts(counts)).toBe("2 High · 1 Low · 1 Unrated");
    expect(summarizeCounts(countFindings([]), 0)).toBe("No findings");
    expect(summarizeCounts(null)).toBe("No results");
  });
});

describe("run status helpers", () => {
  it("treats running and detached scans as live", () => {
    expect(isLive({ status: "running" })).toBe(true);
    expect(isLive({ status: "detached" })).toBe(true);
    expect(isLive({ status: "completed" })).toBe(false);
    expect(isLive({ status: "gone" })).toBe(false);
  });
  it("names stages and tones", () => {
    expect(stageLabel("clone")).toBe("Cloning");
    expect(stageLabel(null)).toBe("Starting");
    expect(stageLabel("something-new")).toBe("something-new");
    expect(statusTone("completed")).toBe("good");
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("running")).toBe("acc");
  });
});

describe("units", () => {
  it("offers only online Linux units", () => {
    const linux = makeSpark("a");
    const offline = makeSpark("b", false);
    const windows = { ...makeSpark("c"), platform: "windows" as const };
    const mac = { ...makeSpark("d"), platform: "darwin" as const };
    const explicit = { ...makeSpark("e"), platform: "linux" as const };
    expect(eligibleUnits([linux, offline, windows, mac, explicit]).map((s) => s.id)).toEqual(["a", "e"]);
  });
});

describe("source hints", () => {
  it("accepts the documented examples", () => {
    expect(sourceHint("url", "https://github.com/org/repo")).toBeNull();
    expect(sourceHint("path", "~/code/project")).toBeNull();
    expect(sourceHint("path", "/home/me/src/app-1.2")).toBeNull();
    expect(sourceHint("url", "")).toBeNull();
  });
  it("explains URLs the server would refuse", () => {
    expect(sourceHint("url", "http://github.com/org/repo")).toMatch(/https/);
    expect(sourceHint("url", "git@github.com:org/repo.git")).toMatch(/SSH/);
    expect(sourceHint("url", "ssh://git@host/org/repo")).toMatch(/SSH/);
    expect(sourceHint("url", "https://user:pw@github.com/org/repo")).toMatch(/credentials/);
    expect(sourceHint("url", "https://github.com/org/repo?tab=x")).toMatch(/query/);
    expect(sourceHint("url", "https://github.com")).toMatch(/repository path/);
    expect(sourceHint("url", "github.com/org/repo")).toMatch(/URL/);
    expect(sourceHint("url", "https://github.com/org/my repo")).toMatch(/spaces/);
  });
  it("explains paths the server would refuse", () => {
    expect(sourceHint("path", "code/project")).toMatch(/absolute/);
    expect(sourceHint("path", "~/code/../etc")).toMatch(/\.\./);
    expect(sourceHint("path", "/srv/app;rm")).toMatch(/only letters/);
  });
});

describe("scan form validation", () => {
  it("is blocked until the source is filled and the authorization ticked", () => {
    const empty = checkScanForm(initialForm(FALLBACK_LIMITS));
    expect(empty.ok).toBe(false);
    expect(empty.request).toBeNull();
    expect(empty.blockers).toHaveLength(2);

    const noAuth = checkScanForm(valid({ authorized: false }));
    expect(noAuth.ok).toBe(false);
    expect(noAuth.blockers.join(" ")).toMatch(/authorized/);

    expect(checkScanForm(valid()).ok).toBe(true);
  });

  it("requires its own confirmation to execute code, and sends it only then", () => {
    const off = checkScanForm(valid({ readOnly: false }));
    expect(off.ok).toBe(false);
    expect(off.blockers.join(" ")).toMatch(/execute code/);

    const confirmed = checkScanForm(valid({ readOnly: false, confirmExecute: true }));
    expect(confirmed.ok).toBe(true);
    expect(confirmed.request).toMatchObject({ readOnly: false, confirmExecute: true, authorized: true });

    // A stale confirmation never leaks into a read-only request.
    const readOnly = checkScanForm(valid({ readOnly: true, confirmExecute: true }));
    expect(readOnly.request?.readOnly).toBe(true);
    expect(readOnly.request).not.toHaveProperty("confirmExecute");
  });

  it("builds a trimmed request with the default time limit and an optional label", () => {
    const check = checkScanForm(valid({ value: "  https://github.com/org/repo  ", label: "  audit  " }));
    expect(check.request).toEqual({
      source: { type: "url", value: "https://github.com/org/repo" },
      readOnly: true,
      authorized: true,
      timeoutMinutes: 240,
      label: "audit",
    });
    expect(checkScanForm(valid({ label: "   " })).request).not.toHaveProperty("label");
  });

  it("validates the time limit against the server limits", () => {
    const limits = { defaultTimeoutMinutes: 60, minTimeoutMinutes: 10, maxTimeoutMinutes: 120 };
    expect(checkScanForm(valid({ timeoutMinutes: "9" }), limits).ok).toBe(false);
    expect(checkScanForm(valid({ timeoutMinutes: "121" }), limits).ok).toBe(false);
    expect(checkScanForm(valid({ timeoutMinutes: "" }), limits).ok).toBe(false);
    expect(checkScanForm(valid({ timeoutMinutes: "1.5" }), limits).timeoutError).toMatch(/between 10 and 120/);
    expect(checkScanForm(valid({ timeoutMinutes: "90" }), limits).request?.timeoutMinutes).toBe(90);
  });

  it("only hints about a doubtful source, it does not block", () => {
    const check = checkScanForm(valid({ value: "http://github.com/org/repo" }));
    expect(check.sourceHint).toMatch(/https/);
    expect(check.ok).toBe(true);
  });
});

describe("mergeLines", () => {
  it("keeps only lines after the last seen sequence number", () => {
    const l = (seq: number) => ({ seq, text: `l${seq}`, stream: "out" as const });
    const merged = mergeLines([l(1), l(2)], [l(2), l(3)]);
    expect(merged.map((x) => x.seq)).toEqual([1, 2, 3]);
    const prev = [l(1)];
    expect(mergeLines(prev, [])).toBe(prev);
    expect(mergeLines([l(1), l(2)], [l(3), l(4)], 3).map((x) => x.seq)).toEqual([2, 3, 4]);
  });
});
