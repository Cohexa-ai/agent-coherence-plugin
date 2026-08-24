/**
 * Branch-ruleset validation tests — check 3b of
 * tools/check_release_readiness.js.
 *
 * Origin: `main` is guarded by TWO independent systems — classic branch
 * protection and the `protect-main` ruleset — which stack and are evaluated
 * separately. The runbook documented only the first (plus the tag ruleset),
 * so the second drifted unseen into a state that forbade the release
 * procedure: `allowed_merge_methods: ["squash"]` with
 * `required_linear_history`, while docs/RELEASE.md §2 step 2 merges the
 * release with a merge commit.
 *
 * v0.4.0 paid for that. It was squash-merged, which left `main` with no
 * ancestry link to `dev`; the next forward-merge came back as add/add
 * conflicts across every file the release touched and had to be resolved by
 * hand (PR #112). Preflight reported 0 failures throughout, because nothing
 * inspected the branch ruleset at all.
 *
 * These tests pin the guard on evaluateBranchRuleset(), the pure verdict
 * function, so the rule logic is exercised without a network round-trip:
 *   1. The exact v0.4.0 shape fails, naming both causes.
 *   2. The corrected shape passes.
 *   3. Each blocking condition fails independently — squash-only,
 *      linear-history, and a missing admin bypass.
 *   4. An absent allowed_merge_methods means "all methods", not "none".
 *   5. Malformed/empty bodies degrade to a verdict, never a throw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain JS tool, no type declarations by design.
import { evaluateBranchRuleset } from "../../tools/check_release_readiness.js";

type Verdict = { ok: boolean; detail: string };

const ADMIN_BYPASS = [{ actor_type: "RepositoryRole", bypass_mode: "always" }];

function prRule(methods?: string[]): Record<string, unknown> {
  return {
    type: "pull_request",
    parameters: {
      required_approving_review_count: 1,
      ...(methods === undefined ? {} : { allowed_merge_methods: methods }),
    },
  };
}

function ruleset(rules: unknown[], bypass: unknown[] = ADMIN_BYPASS): Record<string, unknown> {
  return { name: "protect-main", rules, bypass_actors: bypass };
}

test("the exact v0.4.0 shape fails, naming BOTH blocking causes", () => {
  const v: Verdict = evaluateBranchRuleset(
    ruleset([
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
      prRule(["squash"]),
    ]),
  );
  assert.equal(v.ok, false);
  // Both problems must surface at once — fixing one and re-running should not
  // be the only way to discover the other.
  assert.match(v.detail, /required_linear_history/);
  assert.match(v.detail, /allowed_merge_methods is \[squash\]/);
  assert.match(v.detail, /RELEASE\.md §1/);
});

test("the corrected shape passes", () => {
  const v: Verdict = evaluateBranchRuleset(
    ruleset([{ type: "deletion" }, { type: "non_fast_forward" }, prRule(["merge", "squash"])]),
  );
  assert.equal(v.ok, true);
  assert.match(v.detail, /protect-main/);
});

test("each blocking condition fails on its own", () => {
  const squashOnly: Verdict = evaluateBranchRuleset(ruleset([prRule(["squash"])]));
  assert.equal(squashOnly.ok, false);
  assert.match(squashOnly.detail, /allowed_merge_methods/);
  assert.doesNotMatch(squashOnly.detail, /required_linear_history/);

  const linear: Verdict = evaluateBranchRuleset(
    ruleset([{ type: "required_linear_history" }, prRule(["merge"])]),
  );
  assert.equal(linear.ok, false);
  assert.match(linear.detail, /required_linear_history/);
  assert.doesNotMatch(linear.detail, /allowed_merge_methods/);

  // No admin bypass → main's review rule is unsatisfiable (single collaborator
  // authors every release PR; GitHub refuses self-approval), so no release can
  // merge regardless of merge method.
  const noBypass: Verdict = evaluateBranchRuleset(ruleset([prRule(["merge"])], []));
  assert.equal(noBypass.ok, false);
  assert.match(noBypass.detail, /bypass/);
});

test("an OrganizationAdmin bypass satisfies the bypass requirement", () => {
  const v: Verdict = evaluateBranchRuleset(
    ruleset([prRule(["merge"])], [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }]),
  );
  assert.equal(v.ok, true);
});

test("absent allowed_merge_methods means all methods allowed, not none", () => {
  // GitHub omits the key when every method is permitted. Treating that as
  // "merge is missing" would fail every correctly-configured repo.
  const v: Verdict = evaluateBranchRuleset(ruleset([prRule(undefined)]));
  assert.equal(v.ok, true);
});

test("a ruleset with no pull_request rule is not blocked on merge method", () => {
  const v: Verdict = evaluateBranchRuleset(ruleset([{ type: "deletion" }]));
  assert.equal(v.ok, true);
});

test("malformed bodies produce a verdict, never a throw", () => {
  for (const body of [undefined, null, {}, { rules: "not-an-array" }, { rules: [null] }]) {
    const v: Verdict = evaluateBranchRuleset(body);
    assert.equal(typeof v.ok, "boolean");
    assert.equal(typeof v.detail, "string");
  }
  // No rules and no bypass actors → the bypass problem is still reported.
  assert.equal(evaluateBranchRuleset({}).ok, false);
});
