/**
 * The sorting gate on Stage 2 coding. Pure — no network, no database.
 *
 *   npm run check:coding-gate
 *
 * Two things are checked, and they are deliberately different in kind.
 *
 * The FILTER: applyScope() is exercised against a recording stub that stands
 * in for the Supabase query builder, so the conditions a coding run would send
 * to Postgres are inspectable without a Postgres. This is the check that would
 * have caught the original bug — `not(ai_sorting_flagged is true)` is a
 * perfectly reasonable-looking line that lets every unsorted row through,
 * because an unsorted row's flag is null and null is not true. Reading the
 * code did not catch it for weeks. Reading the emitted conditions does.
 *
 * The ASSERTION: assertSorted() is the backstop for when the filter is wrong
 * anyway — a new caller, a hand-built row list, a future refactor. It throws
 * rather than filtering, because the failure being guarded against is one that
 * stayed invisible precisely because nothing complained about it.
 *
 * Checking both matters. A filter with no assertion is one edit away from
 * silently ungating; an assertion with no filter would throw on every ordinary
 * run. The gate is the pair.
 */
import { buildCodingScopeConditions } from "@/lib/analysis/coding-batch";
import { assertSorted, type CodableArticle } from "@/lib/analysis/coding";

const SCOPE = {
  period: "all" as const,
  from: null,
  to: null,
  channel: "all",
  q: "",
  neg: false,
  sflag: false,
};

function article(id: string, sortingStatus: string | null): CodableArticle {
  return {
    id,
    headline: `headline ${id}`,
    body: null,
    matched_keywords: [],
    ai_sorting_status: sortingStatus,
  };
}

function main() {
  let failures = 0;
  let total = 0;

  function check(label: string, ok: boolean) {
    total += 1;
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }

  // -------------------------------------------------------------------------
  // The filter
  // -------------------------------------------------------------------------
  const codable = buildCodingScopeConditions(SCOPE);

  check(
    `codable selection requires sorting to be complete → ${JSON.stringify(
      codable.find((c) => c.column === "ai_sorting_status") ?? null
    )}`,
    codable.some(
      (c) =>
        c.op === "eq" &&
        c.column === "ai_sorting_status" &&
        c.value === "complete"
    )
  );

  check(
    "codable selection still excludes flagged articles",
    codable.some((c) => c.op === "not" && c.column === "ai_sorting_flagged")
  );

  check(
    "codable selection still excludes non-active and already-coded",
    codable.some(
      (c) => c.op === "eq" && c.column === "status" && c.value === "active"
    ) &&
      codable.some(
        (c) =>
          c.op === "eq" && c.column === "coded_status" && c.value === "pending"
      )
  );

  // The regression this whole file exists for. An unsorted row has a null
  // flag, so a rule expressed ONLY as "not flagged" admits it. The gate must
  // be a positive statement about sorting having run, not a negative one about
  // its verdict.
  const flagRuleAlone = codable.filter((c) =>
    c.column.startsWith("ai_sorting")
  );
  check(
    "the sorting gate is positive, not merely 'not flagged' (the original bug)",
    flagRuleAlone.some((c) => c.op === "eq" && c.column === "ai_sorting_status")
  );

  // The skipped-flagged count must be about the SAME population — sorted
  // articles — or the two numbers quoted to the analyst are not comparable.
  const flagged = buildCodingScopeConditions(SCOPE, { onlyFlagged: true });
  check(
    "the skipped-flagged count is also restricted to sorted articles",
    flagged.some(
      (c) =>
        c.op === "eq" &&
        c.column === "ai_sorting_status" &&
        c.value === "complete"
    ) &&
      flagged.some(
        (c) =>
          c.op === "eq" && c.column === "ai_sorting_flagged" && c.value === true
      )
  );

  // The awaiting-sorting count looks at the other side of the gate, and must
  // NOT apply the flag rule — there is no verdict to ask about yet.
  const pending = buildCodingScopeConditions(SCOPE, {
    sortingStatus: "pending",
  });
  check(
    "the awaiting-sorting count selects pending and asks nothing about the flag",
    pending.some(
      (c) =>
        c.op === "eq" &&
        c.column === "ai_sorting_status" &&
        c.value === "pending"
    ) && !pending.some((c) => c.column === "ai_sorting_flagged")
  );

  // -------------------------------------------------------------------------
  // The assertion
  // -------------------------------------------------------------------------
  let threw = false;
  try {
    assertSorted([article("a", "complete"), article("b", "pending")]);
  } catch {
    threw = true;
  }
  check("assertSorted throws on a pending-sorting article", threw);

  threw = false;
  try {
    assertSorted([article("a", "complete"), article("b", null)]);
  } catch {
    threw = true;
  }
  check("assertSorted throws on an article with no sorting status at all", threw);

  threw = false;
  try {
    assertSorted([article("a", "complete"), article("b", "complete")]);
  } catch {
    threw = true;
  }
  check("assertSorted passes a fully sorted batch", !threw);

  threw = false;
  try {
    assertSorted([]);
  } catch {
    threw = true;
  }
  check("assertSorted passes an empty batch", !threw);

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
