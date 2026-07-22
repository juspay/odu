// grokbe — Grok Build imitation of Claude Code's /be workflow.
//
// Take a task to a shipped, reviewed PR: short interview → implement → draft PR →
// serial AI review gauntlet → CI + evidence. Never merges.
//
// Run:  /grokbe <issue URL or free-text task>
//       /workflow grokbe { "task": "…", "tracks": "adversarial", "from": "gauntlet" }
//
// Slash free-text (`/grokbe fix the flaky e2e`) is bound by the host as
// { query, objective } — NOT as { task }. We accept task | objective | query.
// Structured JSON may still pass task/tracks/from/… explicitly.
//
// Free-text that is a *track directive* (not a product task) is recognized:
//   /grokbe only codex-debate
//   /grokbe skip all but adversarial
// → from=gauntlet, tracks=adversarial (no implement/PR rewrite).
//
// Args:
//   task        (required*) issue URL or free-text prompt
//               *also accepted as objective / query (slash free-text shape)
//   from        (optional)  "start" (default) | "gauntlet" | "ship"
//               gauntlet = /be-review shape: keep branch+PR, run selected tracks
//   plan_first  (optional)  bool — write a plan and pause before implementing (default false)
//   task_kind   (optional)  "bug" | "feature" | "refactor" (default "feature")
//   tracks      (optional)  CSV of gauntlet tracks (default all):
//                           arch,lens,adversarial,simplify,police
//                           (adversarial = real /codex-debate via Kolu, not a substitute)
//                           aliases: codex, codex-debate → adversarial
//   rationale   (optional)  deliberate design decisions reviewers must respect
//   context     (optional)  task intent for the codex-debate author (not codex)
//   base        (optional)  remote-tracking ref to diff against (default origin/HEAD)

let meta = #{
    name: "grokbe",
    description: "End-to-end /be-style delivery: interview → implement → draft PR → serial review gauntlet (arch → lowy⇄hickey → codex-debate via Kolu → simplify → code-police) → CI + evidence. Never merges.",
    when_to_use: "When the user wants the Claude /be workflow under Grok: clarify once, then autonomously ship a reviewed PR.",
    phases: [
        #{ title: "Interview", detail: "confirm plan-first + task kind (or accept args defaults)" },
        #{ title: "Setup", detail: "branch off origin/default; load .agency/do.md" },
        #{ title: "Plan", detail: "optional plan-first pause" },
        #{ title: "Implement", detail: "code + tests + docs; check/fmt; commit; push" },
        #{ title: "PR", detail: "open draft PR via forge-pr guidance" },
        #{ title: "Gauntlet", detail: "serial: arch → lens debate → codex-debate (Kolu) → simplify → police" },
        #{ title: "Ship", detail: "merge latest base; CI + evidence in parallel" },
        #{ title: "Done", detail: "report PR URL + gauntlet + CI; never merge" },
    ],
};

// ── schemas ──────────────────────────────────────────────────────────────────

let setup_schema = #{
    "type": "object",
    "required": ["branch", "base_ref", "merge_base", "check_cmd", "fmt_cmd", "test_cmd", "ok"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "branch": #{ "type": "string" },
        "base_ref": #{ "type": "string" },
        "merge_base": #{ "type": "string" },
        "check_cmd": #{ "type": "string" },
        "fmt_cmd": #{ "type": "string" },
        "test_cmd": #{ "type": "string" },
        "notes": #{ "type": "string" },
    },
};

let plan_schema = #{
    "type": "object",
    "required": ["plan_path", "summary", "ok"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "plan_path": #{ "type": "string" },
        "summary": #{ "type": "string" },
    },
};

let implement_schema = #{
    "type": "object",
    "required": ["ok", "branch", "head_sha", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "branch": #{ "type": "string" },
        "head_sha": #{ "type": "string" },
        "summary": #{ "type": "string" },
        "rationale": #{ "type": "string" },
        "files_touched": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let pr_schema = #{
    "type": "object",
    "required": ["ok", "pr_url", "pr_number"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "pr_url": #{ "type": "string" },
        "pr_number": #{ "type": "integer" },
        "title": #{ "type": "string" },
    },
};

let findings_schema = #{
    "type": "object",
    "required": ["findings", "summary"],
    "properties": #{
        "summary": #{ "type": "string" },
        "skipped": #{ "type": "boolean" },
        "findings": #{
            "type": "array",
            "maxItems": 16,
            "items": #{
                "type": "object",
                "required": ["id", "title", "disposition", "severity", "plan"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "title": #{ "type": "string" },
                    "location": #{ "type": "string" },
                    "severity": #{ "type": "string" },
                    "disposition": #{ "type": "string" },
                    "plan": #{ "type": "string" },
                    "reasoning": #{ "type": "string" },
                },
            },
        },
    },
};

let apply_schema = #{
    "type": "object",
    "required": ["ok", "status", "applied", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "status": #{ "type": "string" },
        "applied": #{
            "type": "array",
            "items": #{
                "type": "object",
                "required": ["id", "title", "commit"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "title": #{ "type": "string" },
                    "commit": #{ "type": "string" },
                },
            },
        },
        "summary": #{ "type": "string" },
        "comment_body": #{ "type": "string" },
        "unresolved": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let stage_schema = #{
    "type": "object",
    "required": ["ok", "changed", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "changed": #{ "type": "boolean" },
        "summary": #{ "type": "string" },
        "commit": #{ "type": "string" },
        "comment_body": #{ "type": "string" },
    },
};

// codex-debate track (real /codex-debate via Kolu — not a Grok-critic substitute)
let codex_schema = #{
    "type": "object",
    "required": ["ok", "status", "summary", "rounds", "effort", "comment_body", "codex_start", "head_sha"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "status": #{ "type": "string", "enum": ["consensus", "reviewer-error", "merge-base-error"] },
        "rounds": #{ "type": "integer", "minimum": 0 },
        "effort": #{ "type": "string", "enum": ["low", "medium", "high", "xhigh"] },
        "summary": #{ "type": "string" },
        "comment_body": #{ "type": "string" },
        "codex_start": #{ "type": "string" },
        "head_sha": #{ "type": "string" },
    },
};

// Gauntlet preflight returns a refreshed merge-base (not free-text-only).
let preflight_schema = #{
    "type": "object",
    "required": ["ok", "merge_base", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "merge_base": #{ "type": "string" },
        "summary": #{ "type": "string" },
        "changed": #{ "type": "boolean" },
    },
};

let ship_schema = #{
    "type": "object",
    "required": ["ok", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "summary": #{ "type": "string" },
        "ci_green": #{ "type": "boolean" },
        "evidence_posted": #{ "type": "boolean" },
        "pr_url": #{ "type": "string" },
    },
};

// ── args ─────────────────────────────────────────────────────────────────────

let a = if args == () {
    #{}
} else if type_of(args) == "string" {
    // Bare string (or JSON-encoded string some hosts pass) is the task itself.
    #{ task: args }
} else {
    args
};

// Task resolution — three shapes the host actually sends:
//   1. { "task": "…" }                     explicit / tool /workflow JSON
//   2. { "query": "…", "objective": "…" }  slash free-text: /grokbe <words>
//   3. "…"                                 bare string
// Prefer task, then objective, then query. Empty string is missing.
fn first_nonempty(x, y, z) {
    if x != () && type_of(x) == "string" {
        x.trim();
        if x != "" {
            return x;
        }
    }
    if y != () && type_of(y) == "string" {
        y.trim();
        if y != "" {
            return y;
        }
    }
    if z != () && type_of(z) == "string" {
        z.trim();
        if z != "" {
            return z;
        }
    }
    ()
}

let task_raw = if a.task != () { a.task } else { () };
let objective_raw = if a.objective != () { a.objective } else { () };
let query_raw = if a.query != () { a.query } else { () };
let task = first_nonempty(task_raw, objective_raw, query_raw);

if task == () || task == "" {
    pause("verification", "Pass a task: `/grokbe <issue URL or free-text>` or `/workflow grokbe {\"task\":\"…\"}`. Optional: from, tracks, plan_first, task_kind, rationale, context, base.");
}

// Normalize a single track token (trim + aliases). Returns "" if empty after trim.
fn normalize_track_token(tok) {
    if tok == () || type_of(tok) != "string" {
        return "";
    }
    let t = tok;
    t.trim();
    if t == "" {
        return "";
    }
    if t == "codex" || t == "codex-debate" || t == "Codex" || t == "Codex-debate" {
        return "adversarial";
    }
    t
}

// Normalize tracks CSV: trim tokens, map aliases, reject unknowns (returns () on bad input).
fn normalize_tracks(csv) {
    if csv == () || csv == "" || csv == "all" {
        return "arch,lens,adversarial,simplify,police";
    }
    // Split on commas without regex: walk by finding commas.
    let remaining = csv;
    let out = "";
    let known = ",arch,lens,adversarial,simplify,police,";
    let saw_any = false;
    // Cap iterations to avoid infinite loop on malformed input.
    let guard = 0;
    while remaining != "" && guard < 32 {
        guard += 1;
        let comma = remaining.index_of(",");
        let piece = remaining;
        if comma >= 0 {
            piece = remaining.sub_string(0, comma);
            remaining = remaining.sub_string(comma + 1, remaining.len() - (comma + 1));
        } else {
            remaining = "";
        }
        let tok = normalize_track_token(piece);
        if tok == "" {
            // skip empty (e.g. trailing comma)
        } else if !(known.contains("," + tok + ",")) {
            return (); // unknown token
        } else {
            if saw_any {
                out += ",";
            }
            out += tok;
            saw_any = true;
        }
    }
    if !saw_any {
        return ();
    }
    out
}

// Strict whole-input directive grammar (not a substring search).
// Accepts only enumerated shapes after trim.
fn is_track_directive(s) {
    if s == () || type_of(s) != "string" {
        return false;
    }
    let t = s;
    t.trim();
    // Exact short tokens
    if t == "codex" || t == "codex-debate" || t == "adversarial" || t == "Codex" {
        return true;
    }
    // Enumerated phrases (common casings users type)
    if t == "only codex-debate" || t == "only codex" || t == "only adversarial"
        || t == "skip all but codex-debate" || t == "skip all but codex" || t == "skip all but adversarial"
        || t == "Skip all but codex-debate" || t == "Skip all but codex" || t == "Skip all but adversarial"
        || t == "just codex-debate" || t == "just codex" || t == "just adversarial"
        || t == "Run codex-debate part of the grokbe workflow only"
        || t == "run codex-debate part of the grokbe workflow only"
        || t == "codex-debate only" || t == "codex only" || t == "adversarial only" {
        true
    } else {
        false
    }
}

let plan_first = if a.plan_first != () { a.plan_first } else { false };
let task_kind = if a.task_kind != () { a.task_kind } else { "feature" };
let tracks_csv = "arch,lens,adversarial,simplify,police";
if a.tracks != () {
    let nt = normalize_tracks(a.tracks);
    if nt == () {
        pause("verification", "Invalid tracks CSV: " + a.tracks + " — use arch,lens,adversarial|codex|codex-debate,simplify,police (comma-separated).");
    }
    tracks_csv = nt;
}
let from_arg = if a.from != () { a.from } else { "start" };
if type_of(from_arg) == "string" {
    from_arg.trim();
}
let rationale = if a.rationale != () { a.rationale } else { "" };
let user_context = if a.context != () { a.context } else { "" };
let base_arg = if a.base != () { a.base } else { "" };

// Free-text directive → gauntlet-only + adversarial.
// ONLY when the resolved task came from slash query/objective (no explicit task)
// AND caller did not set tracks/from. Never rewrite an explicit product task.
let from_slash_only = (task_raw == () || task_raw == "")
    && (objective_raw != () || query_raw != ());
if from_slash_only && a.tracks == () && a.from == () && is_track_directive(task) {
    tracks_csv = "adversarial";
    from_arg = "gauntlet";
    if user_context == "" {
        user_context = task;
    }
    task = "Review and debate the current branch (gauntlet-only; no new implementation).";
    log("parsed free-text track directive → from=" + from_arg + " tracks=" + tracks_csv);
}

// from aliases (only documented ones)
if from_arg == "review" || from_arg == "be-review" || from_arg == "gauntlet-only" {
    from_arg = "gauntlet";
}
// Fail closed on unknown from — never silently escalate to mutating start.
if from_arg != "start" && from_arg != "gauntlet" && from_arg != "ship" {
    pause("verification", "Invalid from=" + from_arg + " — use start | gauntlet | ship (aliases: review, be-review, gauntlet-only).");
}

let do_plan_impl_pr = from_arg == "start";
let do_gauntlet = from_arg == "start" || from_arg == "gauntlet";
let do_ship = from_arg == "start" || from_arg == "ship";
// Gauntlet-only still posts push+comment after tracks; ship (CI+evidence) is optional.
// When from=gauntlet, skip ship by default (mirrors /be-review). from=ship runs ship only.

fn track_on(csv, name) {
    if csv == () || csv == "" || csv == "all" {
        return true;
    }
    // Comma-pad so "arch" does not match a hypothetical "architecture" token.
    let padded = "," + csv + ",";
    let needle = "," + name + ",";
    if padded.contains(needle) {
        return true;
    }
    // codex / codex-debate aliases for the adversarial track
    if name == "adversarial" {
        if padded.contains(",codex,") || padded.contains(",codex-debate,") {
            return true;
        }
    }
    false
}

fn bool_str(b) {
    if b {
        "true"
    } else {
        "false"
    }
}

let do_arch = track_on(tracks_csv, "arch");
let do_lens = track_on(tracks_csv, "lens");
let do_adversarial = track_on(tracks_csv, "adversarial");
let do_simplify = track_on(tracks_csv, "simplify");
let do_police = track_on(tracks_csv, "police");

// ── Interview ────────────────────────────────────────────────────────────────
// No gate. A resolved task is a committed launch: defaults apply
// unless the caller set knobs. Missing task already pause()'d above.

phase("Interview");
log("grokbe start — from=" + from_arg + " task_kind=" + task_kind + " plan_first=" + bool_str(plan_first) + " tracks=" + tracks_csv + " task=" + task);

// ── Setup ────────────────────────────────────────────────────────────────────

phase("Setup");

let setup_prompt = "";
setup_prompt += "You are the setup step of the grokbe workflow (Claude /be §1).\n";
setup_prompt += "EXECUTE NOW. Do not wait for confirmation. Do not return a plan — do the work.\n\n";
setup_prompt += "Task: " + task + "\n";
setup_prompt += "task_kind: " + task_kind + "\n";
setup_prompt += "plan_first: " + bool_str(plan_first) + "\n";
setup_prompt += "from: " + from_arg + "\n";
if base_arg != "" {
    setup_prompt += "Preferred base ref: " + base_arg + "\n";
}
setup_prompt += "\nDo all of the following with shell/git tools:\n";
setup_prompt += "1. git fetch origin\n";
setup_prompt += "2. Resolve the default remote branch: git symbolic-ref --short refs/remotes/origin/HEAD\n";
setup_prompt += "   Fallback origin/master. If a preferred base was given, use it (must be a remote-tracking ref).\n";
if from_arg == "gauntlet" || from_arg == "ship" {
    setup_prompt += "3. Gauntlet/ship-only mode: KEEP the current branch. Do NOT create a new branch.\n";
    setup_prompt += "   Fail if HEAD is master/main (must be a feature branch with a diff vs base).\n";
    setup_prompt += "   Report the current branch name as branch.\n";
} else {
    setup_prompt += "3. Create a feature branch off that origin ref. NEVER commit to master/main.\n";
    setup_prompt += "   Branch name: grokbe/<short-slug-from-task> (lowercase, hyphens, ≤40 chars).\n";
    setup_prompt += "   If already on a suitable non-default feature branch with work, keep it and report it.\n";
}
setup_prompt += "4. Read .agency/do.md if it exists — extract check / fmt / test / CI / PR-evidence commands.\n";
setup_prompt += "   odu defaults if missing: check=`pnpm typecheck`, test=`pnpm test:unit`, fmt=`just fmt` if present else biome/prettier probe.\n";
setup_prompt += "5. Compute merge-base: git merge-base <base_ref> HEAD\n";
setup_prompt += "6. Return structured output. ok=true only if branch exists and base_ref is set.\n";

let setup_r = agent(setup_prompt, #{
    label: "setup",
    capability_mode: "all",
    output_schema: setup_schema,
});

if setup_r == () || !setup_r.success || setup_r.output == () || setup_r.output.ok != true {
    complete(#{
        ok: false,
        phase: "setup",
        summary: "Setup failed — could not create branch or resolve base.",
        detail: setup_r,
    });
}

let branch = setup_r.output.branch;
let base_ref = setup_r.output.base_ref;
let merge_base = setup_r.output.merge_base;
let check_cmd = setup_r.output.check_cmd;
let fmt_cmd = setup_r.output.fmt_cmd;
let test_cmd = setup_r.output.test_cmd;
log("setup ok — branch=" + branch + " base=" + base_ref + " mb=" + merge_base);

// ── Plan / Implement / PR (skipped when from=gauntlet|ship) ──────────────────

let plan_path = "";
let plan_summary = "";
let head_sha = "";
let impl_summary = "";
let pr_url = "";
let pr_number = 0;

if do_plan_impl_pr {
if plan_first == true {
    phase("Plan");
    let plan_prompt = "";
    plan_prompt += "You are the plan-first step of grokbe (Claude /be §1 plan-first).\n";
    plan_prompt += "EXECUTE NOW. Write the plan of record; do not implement code yet.\n\n";
    plan_prompt += "Task: " + task + "\n";
    plan_prompt += "task_kind: " + task_kind + "\n";
    plan_prompt += "Branch: " + branch + "\n";
    plan_prompt += "Base: " + base_ref + "\n\n";
    plan_prompt += "Rules for the plan:\n";
    plan_prompt += "(a) High-level — user- and architecture-focused (what + shape + trade-offs). NO line-level code dumps.\n";
    plan_prompt += "(b) Ground load-bearing facts against installed code (lockfile versions, real APIs) — never invent.\n";
    plan_prompt += "(c) If the change has any on-screen surface, include a brief UI sketch (ASCII/markdown mock).\n";
    plan_prompt += "(d) Honor design philosophy in .claude/rules/conventions.md if present (fail-fast, no-fallbacks, reuse).\n\n";
    plan_prompt += "Write the plan to docs/plans/grokbe-<slug>.md (create docs/plans/ if needed).\n";
    plan_prompt += "Commit it: docs(plan): <title>. Push the branch.\n";
    plan_prompt += "Return plan_path, a short summary, ok=true.\n";

    let plan_r = agent(plan_prompt, #{
        label: "plan",
        capability_mode: "all",
        output_schema: plan_schema,
    });

    if plan_r == () || !plan_r.success || plan_r.output == () || plan_r.output.ok != true {
        complete(#{
            ok: false,
            phase: "plan",
            summary: "Plan-first step failed.",
            detail: plan_r,
        });
    }
    plan_path = plan_r.output.plan_path;
    plan_summary = plan_r.output.summary;
    log("plan written at " + plan_path);

    let plan_gate = "Plan ready at " + plan_path + "\n\n" + plan_summary;
    plan_gate += "\n\nResume to implement. Cancel to stop. Feedback can be added by editing the plan file before resume.";
    await_user("user", plan_gate);
}

// ── Implement ────────────────────────────────────────────────────────────────

phase("Implement");

let impl_prompt = "";
impl_prompt += "You are the implement step of grokbe (Claude /be §2). EXECUTE NOW — implement, do not plan-and-wait.\n\n";
impl_prompt += "Task: " + task + "\n";
impl_prompt += "task_kind: " + task_kind + "\n";
impl_prompt += "Branch: " + branch + " (stay on it)\n";
impl_prompt += "Base / merge-base: " + base_ref + " / " + merge_base + "\n";
impl_prompt += "check: " + check_cmd + "\n";
impl_prompt += "fmt: " + fmt_cmd + "\n";
impl_prompt += "test: " + test_cmd + "\n";
if plan_path != "" {
    impl_prompt += "Plan of record: " + plan_path + " — implement that plan.\n";
}
if rationale != "" {
    impl_prompt += "Author rationale (preserve these decisions): " + rationale + "\n";
}
if user_context != "" {
    impl_prompt += "Context: " + user_context + "\n";
}
impl_prompt += "\nDesign philosophy first — re-read .claude/rules/conventions.md Design philosophy if present:\n";
impl_prompt += "fail-fast / no-fallbacks · electricity boundaries · reuse existing source of truth.\n\n";
impl_prompt += "By task_kind:\n";
impl_prompt += "• bug — reproduce BEFORE theorizing or fixing. Pin one hard observable fact. Build a red repro, then fix until green.\n";
impl_prompt += "  Disabling the feature is a mitigation, not a fix. Reject no-fallbacks violations.\n";
impl_prompt += "• feature — write covering tests before or alongside the change.\n";
impl_prompt += "• refactor — no test-first requirement; rely on existing coverage.\n\n";
impl_prompt += "Docs: read .agency/do.md ## Documentation. Grep every doc surface for terms you touch; update or record why accurate.\n";
impl_prompt += "README.md at minimum for user-facing changes.\n\n";
impl_prompt += "Run check + fmt + relevant tests. Commit with a conventional message. Push the feature branch.\n";
impl_prompt += "Return ok, branch, head_sha, summary of what shipped, rationale (deliberate decisions for reviewers),\n";
impl_prompt += "and files_touched. ok=false if check/tests fail and you cannot fix them.\n";

let impl_r = agent(impl_prompt, #{
    label: "implement",
    capability_mode: "all",
    output_schema: implement_schema,
});

if impl_r == () || !impl_r.success || impl_r.output == () || impl_r.output.ok != true {
    complete(#{
        ok: false,
        phase: "implement",
        summary: "Implementation failed or check/tests red.",
        detail: impl_r,
        branch: branch,
    });
}

branch = impl_r.output.branch;
head_sha = impl_r.output.head_sha;
impl_summary = impl_r.output.summary;
if impl_r.output.rationale != () && impl_r.output.rationale != "" {
    if rationale == "" {
        rationale = impl_r.output.rationale;
    } else {
        rationale = rationale + "\n" + impl_r.output.rationale;
    }
}
log("implement ok — " + head_sha + " — " + impl_summary);

// ── Open PR ──────────────────────────────────────────────────────────────────

phase("PR");

let pr_prompt = "";
pr_prompt += "You are the PR step of grokbe (Claude /be §3). EXECUTE NOW.\n\n";
pr_prompt += "Branch: " + branch + "\n";
pr_prompt += "Base: " + base_ref + "\n";
pr_prompt += "Task: " + task + "\n";
pr_prompt += "Implementation summary: " + impl_summary + "\n";
if plan_path != "" {
    pr_prompt += "Plan of record: " + plan_path + "\n";
}
pr_prompt += "\nRead .claude/skills/forge-pr/SKILL.md and follow it for title/body craft.\n";
pr_prompt += "Create a DRAFT PR: gh pr create --draft with a genuine title/body covering the scope so far.\n";
pr_prompt += "Use a single-quoted heredoc for --body so backticks survive (see forge-pr SKILL).\n";
pr_prompt += "Attribution footer: Generated by /grokbe on Grok Build.\n";
pr_prompt += "If a PR for this branch already exists, reuse it (gh pr view) and update title/body if needed — do not open a duplicate.\n";
pr_prompt += "If plan_path is set, mark the plan as implemented and link the PR number, commit, push.\n";
pr_prompt += "Return ok, pr_url, pr_number, title.\n";

let pr_r = agent(pr_prompt, #{
    label: "open-pr",
    capability_mode: "all",
    output_schema: pr_schema,
});

if pr_r == () || !pr_r.success || pr_r.output == () || pr_r.output.ok != true {
    complete(#{
        ok: false,
        phase: "pr",
        summary: "Failed to open draft PR.",
        detail: pr_r,
        branch: branch,
        head_sha: head_sha,
    });
}

pr_url = pr_r.output.pr_url;
pr_number = pr_r.output.pr_number;
log("PR opened — " + pr_url);

} else {
    // from=gauntlet|ship: reuse current branch + existing PR (no implement).
    phase("PR");
    let pr_reuse_prompt = "";
    pr_reuse_prompt += "You are the PR-resolve step of grokbe (from=" + from_arg + "). EXECUTE NOW.\n";
    pr_reuse_prompt += "Branch: " + branch + "  Base: " + base_ref + "\n";
    pr_reuse_prompt += "1. Discover existing PR: gh pr view --json number,url,title (current branch).\n";
    pr_reuse_prompt += "2. If NONE exists: set ok=false — do NOT open a draft. Caller must create a PR first.\n";
    pr_reuse_prompt += "3. If found: return ok=true, pr_url, pr_number, title.\n";
    pr_reuse_prompt += "Fail closed. No side effects other than reading gh.\n";

    let pr_r = agent(pr_reuse_prompt, #{
        label: "reuse-pr",
        capability_mode: "all",
        output_schema: pr_schema,
    });
    if pr_r == () || !pr_r.success || pr_r.output == () || pr_r.output.ok != true {
        complete(#{
            ok: false,
            phase: "pr",
            summary: "from=" + from_arg + " needs an existing PR on this branch (gh pr view found none — create one, then re-run).",
            detail: pr_r,
            branch: branch,
        });
    }
    pr_url = pr_r.output.pr_url;
    pr_number = pr_r.output.pr_number;
    if from_arg == "ship" {
        impl_summary = "ship-only — no implement (from=ship)";
    } else {
        impl_summary = "gauntlet-only — no implement (from=gauntlet)";
    }
    log("reused PR — " + pr_url);
}

// Capture gauntlet start SHA (preflight of /be-review)
let gauntlet_notes = [];
let lens_comment = "";
let adversarial_comment = "";
let police_comment = "";
// Proof-gate invariants: selected adversarial track must reach consensus;
// deferred push/comment must succeed when the gauntlet ran.
let gauntlet_ok = true;
let push_ok = true;

// ── Gauntlet (serial — each step sole editor) ────────────────────────────────
// Mirrors /be-review: collisions are an edit problem; serial makes them impossible.

if !do_gauntlet {
    gauntlet_notes.push("gauntlet: skipped (from=" + from_arg + ")");
    log("gauntlet skipped — from=" + from_arg);
} else {

phase("Gauntlet");
log("gauntlet start — tracks=" + tracks_csv + " base/mb=" + base_ref + "/" + merge_base);

// Refresh merge-base once for the whole gauntlet (be-review preflight).
let preflight_prompt = "";
preflight_prompt += "Gauntlet preflight for grokbe. EXECUTE NOW.\n";
preflight_prompt += "Repo is the cwd worktree. Branch: " + branch + "\n";
preflight_prompt += "Base ref: " + base_ref + "\n";
preflight_prompt += "1. git fetch origin\n";
preflight_prompt += "2. Confirm non-empty diff vs " + base_ref + " (or merge-base). If empty, ok=false summary='empty diff'.\n";
preflight_prompt += "3. Ensure working tree clean — if dirty, ok=false (do not auto-commit leftovers).\n";
preflight_prompt += "4. Recompute merge-base: git merge-base " + base_ref + " HEAD → return as merge_base (required SHA field).\n";
preflight_prompt += "5. Trusted-diff note (codex --yolo): this gauntlet assumes a TRUSTED local branch (your own work).\n";
preflight_prompt += "   Do not review untrusted third-party PRs with YOLO. Surface that in summary if the PR author is not the current gh user.\n";
preflight_prompt += "Return: ok, merge_base (40-char or short SHA), summary.\n";

let pref_r = agent(preflight_prompt, #{
    label: "gauntlet-preflight",
    capability_mode: "all",
    output_schema: preflight_schema,
});

if pref_r == () || !pref_r.success || pref_r.output == () || pref_r.output.ok != true {
    complete(#{
        ok: false,
        phase: "gauntlet-preflight",
        summary: "Gauntlet preflight failed (empty diff or dirty tree?).",
        pr_url: pr_url,
        detail: pref_r,
    });
}
if pref_r.output.merge_base != () && pref_r.output.merge_base != "" {
    merge_base = pref_r.output.merge_base;
    log("gauntlet preflight refreshed merge_base=" + merge_base);
}

// ── Track: arch (architecture-first-principles) ──────────────────────────────

if do_arch {
    log("track: arch");
    let arch_review_prompt = "";
    arch_review_prompt += "You are the architecture-first-principles track of grokbe's gauntlet (runs FIRST).\n";
    arch_review_prompt += "Read .claude/skills/architecture-first-principles/SKILL.md and apply its named checks (C1–C7) to the diff.\n";
    arch_review_prompt += "Scope: git diff " + merge_base + "...HEAD plus one hop down imports of touched files.\n";
    arch_review_prompt += "Also read .agency/architecture-first-principles.md if present.\n";
    arch_review_prompt += "Rationale to respect (do not flag these): " + rationale + "\n";
    arch_review_prompt += "Context: " + user_context + "\n\n";
    arch_review_prompt += "Skip ONLY for pure-docs or trivially-local diffs with no concurrency/ordering claim — and say so.\n";
    arch_review_prompt += "A race-fix whose correctness leans on happens-before is NOT trivially-local.\n";
    arch_review_prompt += "Use read-only tools (read_file, grep, git diff). Do NOT edit.\n";
    arch_review_prompt += "Return findings with disposition fix|drop. Empty findings + skipped=true is valid after a real skip decision.\n";

    let arch_findings_r = agent(arch_review_prompt, #{
        label: "arch:review",
        capability_mode: "read-only",
        agent_type: "explore",
        output_schema: findings_schema,
    });

    let arch_findings_json = "[]";
    if arch_findings_r != () && arch_findings_r.success && arch_findings_r.output != () {
        arch_findings_json = json_encode(arch_findings_r.output);
        gauntlet_notes.push("arch: " + arch_findings_r.output.summary);
    } else {
        gauntlet_notes.push("arch: review agent failed — continuing");
    }

    let arch_apply_prompt = "";
    arch_apply_prompt += "You are the architecture-apply step. EXECUTE NOW.\n";
    arch_apply_prompt += "Merge-base: " + merge_base + "\n";
    arch_apply_prompt += "Findings JSON:\n" + arch_findings_json + "\n\n";
    arch_apply_prompt += "For each finding with disposition fix: implement the plan, stage only its files,\n";
    arch_apply_prompt += "commit as fix(arch): <title>. One commit per finding.\n";
    arch_apply_prompt += "Drop findings stay dropped. Never push. Never merge.\n";
    arch_apply_prompt += "If no fix findings, ok=true status=clean applied=[] summary='no arch fixes'.\n";
    arch_apply_prompt += "Return ok, status (clean|applied), applied[{id,title,commit}], summary, comment_body (short PR comment or empty).\n";

    let arch_apply_r = agent(arch_apply_prompt, #{
        label: "arch:apply",
        capability_mode: "all",
        output_schema: apply_schema,
    });
    if arch_apply_r != () && arch_apply_r.success && arch_apply_r.output != () {
        gauntlet_notes.push("arch apply: " + arch_apply_r.output.summary);
    }
} else {
    gauntlet_notes.push("arch: skipped via tracks");
}

// ── Track: lens (lowy ⇄ hickey independent review → reconcile → apply) ───────

if do_lens {
    log("track: lens (lowy ∥ hickey → reconcile → apply)");

    let lens_common = "";
    lens_common += "Scope: git diff " + merge_base + "...HEAD (whole modules of touched files, not just hunks).\n";
    lens_common += "Rationale to respect: " + rationale + "\n";
    lens_common += "Context: " + user_context + "\n";
    lens_common += "Also read .agency/lowy.md / .agency/hickey.md if present for project patterns.\n";
    lens_common += "Do NOT edit. Use read_file/grep/git. There is NO Defer disposition — fix-in-this-PR or no-op only.\n";
    lens_common += "Severity: major for structural/correctness; minor otherwise.\n";
    lens_common += "Return ≤16 findings as structured JSON. Empty findings is valid only after a full read of the diff.\n";

    let lowy_prompt = "";
    lowy_prompt += "You are the lowy lens in an independent parallel review (grokbe lens-debate).\n";
    lowy_prompt += "Read .claude/skills/lowy/SKILL.md and apply Juval Lowy volatility-based decomposition.\n";
    lowy_prompt += "Core question: do boundaries encapsulate axes of change, or group related functionality?\n";
    lowy_prompt += "Run the electricity probe: name the receptacle, the volatile implementations, electricity vs app concern.\n";
    lowy_prompt += lens_common;
    lowy_prompt += "Prefix finding ids with L (L1, L2, …).\n";

    let hickey_prompt = "";
    hickey_prompt += "You are the hickey lens in an independent parallel review (grokbe lens-debate).\n";
    hickey_prompt += "Read .claude/skills/hickey/SKILL.md and apply Rich Hickey Simple Made Easy structural simplicity.\n";
    hickey_prompt += "Core question: are independent concerns complected, or one thing fragmented?\n";
    hickey_prompt += "Work Layers 1–7. Fact-check your own evaluation before returning.\n";
    hickey_prompt += lens_common;
    hickey_prompt += "Prefix finding ids with H (H1, H2, …).\n";
    hickey_prompt += "IMPORTANT: you must NOT see lowy's findings — form your own from the code only.\n";

    let lens_jobs = [
        #{
            prompt: lowy_prompt,
            label: "lens:lowy",
            capability_mode: "read-only",
            agent_type: "lowy",
            output_schema: findings_schema,
        },
        #{
            prompt: hickey_prompt,
            label: "lens:hickey",
            capability_mode: "read-only",
            agent_type: "hickey",
            output_schema: findings_schema,
        },
    ];
    let lens_reviews = parallel(lens_jobs);

    let lowy_json = "{\"findings\":[],\"summary\":\"lowy failed\"}";
    let hickey_json = "{\"findings\":[],\"summary\":\"hickey failed\"}";
    if lens_reviews[0] != () && lens_reviews[0].success && lens_reviews[0].output != () {
        lowy_json = json_encode(lens_reviews[0].output);
        gauntlet_notes.push("lowy: " + lens_reviews[0].output.summary);
    } else {
        gauntlet_notes.push("lowy: review failed");
    }
    if lens_reviews[1] != () && lens_reviews[1].success && lens_reviews[1].output != () {
        hickey_json = json_encode(lens_reviews[1].output);
        let hickey_sum = "ok";
        if lens_reviews[1].output.summary != () {
            hickey_sum = lens_reviews[1].output.summary;
        }
        gauntlet_notes.push("hickey: " + hickey_sum);
    } else {
        gauntlet_notes.push("hickey: review failed");
    }

    // Reconcile + apply in one editor session (serial sole-writer).
    let lens_apply_prompt = "";
    lens_apply_prompt += "You are the lens reconcile+apply step of grokbe (Claude /lens-debate Apply).\n";
    lens_apply_prompt += "EXECUTE NOW. You are the sole editor on this branch.\n";
    lens_apply_prompt += "Merge-base: " + merge_base + "  Branch: " + branch + "\n";
    lens_apply_prompt += "Rationale: " + rationale + "\n\n";
    lens_apply_prompt += "Independent lowy findings JSON:\n" + lowy_json + "\n\n";
    lens_apply_prompt += "Independent hickey findings JSON:\n" + hickey_json + "\n\n";
    lens_apply_prompt += "Reconcile rules (mirror /lens-debate):\n";
    lens_apply_prompt += "1. Pair findings both lenses raised about the same underlying issue with compatible fix plans → settle as fix (or drop if both drop).\n";
    lens_apply_prompt += "2. Solo major findings → keep unless clearly contradicted by the other lens's silence on a pure-style nit; prefer keep for structural issues.\n";
    lens_apply_prompt += "3. Solo minor findings in a region the other lens never flagged → auto-settle as raised.\n";
    lens_apply_prompt += "4. Contested (same issue, different disposition/plan): adjudicate from the CODE — pick the simpler volatility-correct plan, or drop if neither plan holds.\n";
    lens_apply_prompt += "5. There is no Defer. Every settled fix is applied in THIS PR.\n\n";
    lens_apply_prompt += "Apply each settled fix as its own commit: fix(lens): <title>, staging only that fix's files.\n";
    lens_apply_prompt += "Never push. Never merge. Do not post a PR comment yet (deferred until after final push).\n";
    lens_apply_prompt += "Build comment_body as a markdown summary for later posting:\n";
    lens_apply_prompt += "## [⚖️ Lowy ⇄ Hickey lens debate](https://kolu.dev/blog/hickey-lowy/)\n";
    lens_apply_prompt += "status, finding counts, applied fixes with commit SHAs, drops, unresolved.\n";
    lens_apply_prompt += "Return ok, status (clean|consensus|unresolved), applied[], summary, comment_body, unresolved[].\n";

    let lens_apply_r = agent(lens_apply_prompt, #{
        label: "lens:apply",
        capability_mode: "all",
        output_schema: apply_schema,
    });

    if lens_apply_r != () && lens_apply_r.success && lens_apply_r.output != () {
        gauntlet_notes.push("lens apply: " + lens_apply_r.output.status + " — " + lens_apply_r.output.summary);
        if lens_apply_r.output.comment_body != () {
            lens_comment = lens_apply_r.output.comment_body;
        }
        // Adjudicate unresolved in the summary note; apply step should have tried.
        if lens_apply_r.output.status == "unresolved" {
            gauntlet_notes.push("lens: unresolved findings remain — see comment_body");
        }
    } else {
        gauntlet_notes.push("lens apply: failed");
    }
} else {
    gauntlet_notes.push("lens: skipped via tracks");
}

// ── Track: adversarial = real /codex-debate via Kolu ─────────────────────────
// Claude /be-review §codex: live codex split ⇄ author, to consensus, no cap.
// Grok is the author; Codex is the independent reviewer. NOT a same-model
// critic substitute. Engine = /codex-debate skill + /kolu drive protocol.

if do_adversarial {
    log("track: adversarial (codex-debate via Kolu)");

    let codex_prompt = "";
    codex_prompt += "You are the codex-debate track of grokbe's gauntlet (Claude /be-review step 2).\n";
    codex_prompt += "EXECUTE NOW. Run the REAL `/codex-debate` review protocol — not a Grok-critic substitute.\n\n";
    codex_prompt += "Branch: " + branch + "\n";
    codex_prompt += "Merge-base (base for the debate): " + merge_base + "\n";
    codex_prompt += "PR: #" + pr_number.to_string() + " (" + pr_url + ")\n";
    codex_prompt += "Task/context (author-only, for YOUR fix/dispute reasoning): " + task + "\n";
    if user_context != "" {
        codex_prompt += "Extra context (author-only): " + user_context + "\n";
    }
    if rationale != "" {
        codex_prompt += "Rationale (thread into codex round-1 + your own reasoning — do not 'fix' deliberate decisions): " + rationale + "\n";
    }
    codex_prompt += "\n## Required reading (do this first)\n";
    codex_prompt += "1. Read `.claude/skills/codex-debate/SKILL.md` end-to-end — that is the contract.\n";
    codex_prompt += "2. Read `.claude/skills/kolu/SKILL.md` (and TUI.md if MCP is unavailable) — terminal drive protocol.\n";
    codex_prompt += "3. You are the AUTHOR. Codex is the independent REVIEWER. Independence is the point.\n\n";
    codex_prompt += "## Hard constraints (acceptance for this track)\n";
    codex_prompt += "- Spawn a **live `codex` session via Kolu** as a **split terminal parented to your own terminal**\n";
    codex_prompt += "  (MCP `lifecycle_create` with `parentId`, or `padi-tui create --parent` fallback).\n";
    codex_prompt += "  Launch: `codex --yolo` at effort **xhigh**, cwd = this repo. Confirm footer shows YOLO before dispatch.\n";
    codex_prompt += "- **FORBIDDEN:** Grok explore/critic subagents, same-model adversarial loops, artificial round caps,\n";
    codex_prompt += "  deadlock exits, or any substitute for a live Codex reviewer.\n";
    codex_prompt += "- Loop matches `/codex-debate` **review** mode:\n";
    codex_prompt += "  • verdict files under `$REPO/.codex-debate/verdict-NNN.json` (schema in the skill)\n";
    codex_prompt += "  • consensus only when `approved: true` (every finding resolved, every severity)\n";
    codex_prompt += "  • **no round cap, no deadlock exit** (resolved-and-deferred gates only for genuine ship-phase items)\n";
    codex_prompt += "  • per-round commits of agreed fixes (path-only staging; never `git add -A`)\n";
    codex_prompt += "  • talk via files + short pointer (multi-line paste rule); re-ask on missing/malformed verdict — never guess\n";
    codex_prompt += "  • record BOTH sides' terminal id **and title** (kaval re-key safety)\n";
    codex_prompt += "- Run with the equivalent of:\n";
    codex_prompt += "  `review --base " + merge_base + " --effort xhigh --no-comment`\n";
    codex_prompt += "  (`--no-comment`: gauntlet posts the compact PR comment AFTER the final push, not now)\n";
    codex_prompt += "- Never push. Never merge. Tear down **only** the codex split you spawned (by id/title, never pattern-kill).\n\n";
    codex_prompt += "## Steps (mirror /be-review codex step)\n";
    codex_prompt += "1. Preflight: `codex login status` (if not logged in → status=reviewer-error, ok=false, stop).\n";
    codex_prompt += "   Clean tree for commit mode; prepare gitignored `.codex-debate/` (wipe prior verdict-*/section-*/ask-*).\n";
    codex_prompt += "2. Capture `CODEX_START=$(git rev-parse HEAD)` before the debate.\n";
    codex_prompt += "3. Spawn + drive the debate to consensus per the skill (you fix/dispute; codex reviews).\n";
    codex_prompt += "4. On **consensus**, assemble the **compact** PR comment body (do NOT post it yet):\n";
    codex_prompt += "   - Header: `## Codex ⇄ Grok debate` then\n";
    codex_prompt += "     `✅ Consensus in N rounds · reviewer effort: xhigh · base: " + merge_base + "`\n";
    codex_prompt += "   - Table of debate commits only (`git log --reverse --oneline $CODEX_START..HEAD`):\n";
    codex_prompt += "     `| Round | Commit | Description |` with **bare** short SHAs (no backticks — GitHub autolink)\n";
    codex_prompt += "   - **Legend** — one line per finding id from verdict files (skill's jq recipe)\n";
    codex_prompt += "   Put that markdown in `comment_body`.\n";
    codex_prompt += "5. On **reviewer-error** / merge-base failure: no false-consensus comment; ok=false; empty comment_body.\n";
    codex_prompt += "6. Return structured output.\n\n";
    codex_prompt += "Return: ok (true only on consensus), status (consensus|reviewer-error|merge-base-error),\n";
    codex_prompt += "rounds (integer), effort=xhigh, summary, comment_body, codex_start, head_sha.\n";

    let codex_r = agent(codex_prompt, #{
        label: "adv:codex-debate",
        capability_mode: "all",
        output_schema: codex_schema,
    });

    if codex_r != () && codex_r.success && codex_r.output != () {
        let cstatus = codex_r.output.status;
        if cstatus == () {
            cstatus = "unknown";
        }
        let csum = codex_r.output.summary;
        if csum == () {
            csum = "";
        }
        gauntlet_notes.push("codex-debate: " + cstatus + " — " + csum);
        if codex_r.output.comment_body != () && codex_r.output.comment_body != "" {
            adversarial_comment = codex_r.output.comment_body;
        }
        // Proof gate: consensus requires ok=true AND status=consensus.
        let consensus = codex_r.output.ok == true && cstatus == "consensus";
        if !consensus {
            gauntlet_ok = false;
            gauntlet_notes.push("codex-debate: PROOF GATE FAIL — no consensus (gauntlet_ok=false)");
        }
    } else {
        gauntlet_ok = false;
        gauntlet_notes.push("codex-debate: agent failed — PROOF GATE FAIL (gauntlet_ok=false)");
    }
} else {
    gauntlet_notes.push("adversarial/codex-debate: skipped via tracks");
}

// ── Track: simplify ──────────────────────────────────────────────────────────

if do_simplify {
    log("track: simplify");
    let simp_prompt = "";
    simp_prompt += "You are the simplify track of grokbe (Claude /be-review simplify / elegance pass).\n";
    simp_prompt += "EXECUTE NOW. Scope: git diff " + merge_base + "...HEAD.\n";
    simp_prompt += "Read .claude/skills/elegance/SKILL.md. Run ONE focused simplification pass over the changed code:\n";
    simp_prompt += "reuse existing helpers, remove unnecessary abstraction, idiomatic style, fewer lines with clearer intent.\n";
    simp_prompt += "Do NOT expand scope. Do NOT re-architect. Prefer delete over add.\n";
    simp_prompt += "If you change anything: run " + check_cmd + ", then commit refactor: simplify <area> (only files you touched).\n";
    simp_prompt += "If nothing to simplify: changed=false.\n";
    simp_prompt += "Never push. Never merge. Return ok, changed, summary, commit (or empty).\n";

    let simp_r = agent(simp_prompt, #{
        label: "simplify",
        capability_mode: "all",
        output_schema: stage_schema,
    });
    if simp_r != () && simp_r.success && simp_r.output != () {
        gauntlet_notes.push("simplify: " + simp_r.output.summary);
    } else {
        gauntlet_notes.push("simplify: failed or empty");
    }
} else {
    gauntlet_notes.push("simplify: skipped via tracks");
}

// ── Track: code-police ───────────────────────────────────────────────────────

if do_police {
    log("track: police");
    let police_prompt = "";
    police_prompt += "You are the code-police track of grokbe (Claude /code-police with --no-elegance).\n";
    police_prompt += "EXECUTE NOW. Scope MUST be git diff " + merge_base + "...HEAD (not origin/HEAD default).\n";
    police_prompt += "Read .claude/skills/code-police/SKILL.md. Also read .agency/code-police.md if present.\n";
    police_prompt += "Run Pass 1 (rule checklist) and Pass 2 (fact-check) only.\n";
    if do_simplify {
        police_prompt += "SKIP Pass 3 (elegance) — simplify already ran this gauntlet.\n";
    } else {
        police_prompt += "Pass 3 (elegance) MAY run briefly because simplify was excluded from tracks.\n";
    }
    police_prompt += "Reviewing principles: never talk yourself out of a finding; prosecutor stance.\n";
    police_prompt += "APPLY every real violation: commit each as fix(police): <title> staging only its files.\n";
    police_prompt += "Never push. Never merge.\n";
    police_prompt += "Return ok, changed, summary, commit (last or empty), comment_body as:\n";
    police_prompt += "## [👮 Code-police](https://agency.srid.ca/)\n plus a short table of findings and actions.\n";

    let police_r = agent(police_prompt, #{
        label: "police",
        capability_mode: "all",
        output_schema: stage_schema,
    });
    if police_r != () && police_r.success && police_r.output != () {
        gauntlet_notes.push("police: " + police_r.output.summary);
        if police_r.output.comment_body != () {
            police_comment = police_r.output.comment_body;
        }
    } else {
        gauntlet_notes.push("police: failed or empty");
    }
} else {
    gauntlet_notes.push("police: skipped via tracks");
}

// ── Push once, then comment (be-review invariant) ────────────────────────────

log("gauntlet: fmt + push + deferred comments");
let push_prompt = "";
push_prompt += "You are the post-gauntlet push+comment step of grokbe. EXECUTE NOW.\n";
push_prompt += "Branch: " + branch + "  PR: #" + pr_number.to_string() + " (" + pr_url + ")\n";
push_prompt += "Base: " + base_ref + "  merge-base: " + merge_base + "\n\n";
push_prompt += "1. Run fmt: " + fmt_cmd + "\n";
push_prompt += "   If it changes files, commit style: just fmt (or style: fmt) staging only what it touched.\n";
push_prompt += "2. If there are unpushed commits on this branch, git push (never --force to default branch).\n";
push_prompt += "   Only after a successful push (or if nothing to push and PR exists) post deferred comments:\n";
push_prompt += "3. Post PR comments with gh pr comment " + pr_number.to_string() + " -F <file> for each non-empty body below.\n";
push_prompt += "   Write each body to a temp file first. Skip empty bodies.\n\n";
push_prompt += "--- LENS COMMENT ---\n" + lens_comment + "\n--- END LENS ---\n\n";
push_prompt += "--- CODEX-DEBATE COMMENT ---\n" + adversarial_comment + "\n--- END CODEX-DEBATE ---\n\n";
push_prompt += "--- POLICE COMMENT ---\n" + police_comment + "\n--- END POLICE ---\n\n";
push_prompt += "If a required push fails, do NOT post comments (SHAs would be local-only). Report failure.\n";
push_prompt += "NEVER merge the PR.\n";
push_prompt += "Return ok, changed (true if pushed anything), summary, commit=''.\n";

let push_r = agent(push_prompt, #{
    label: "push-comment",
    capability_mode: "all",
    output_schema: stage_schema,
});
if push_r != () && push_r.success && push_r.output != () && push_r.output.ok == true {
    gauntlet_notes.push("push/comment: " + push_r.output.summary);
} else {
    push_ok = false;
    gauntlet_notes.push("push/comment: FAILED (push_ok=false)");
}

} // end do_gauntlet

// ── Ship: merge latest base, then CI + evidence in parallel ──────────────────

let ci_ok = false;
let ci_summary = "ci skipped (from=" + from_arg + ")";
let evidence_ok = true;
let evidence_summary = "evidence skipped (from=" + from_arg + ")";
let evidence_posted = false;

if do_ship {

phase("Ship");

let sync_prompt = "";
sync_prompt += "Ship pre-sync for grokbe (Claude /be §5). EXECUTE NOW.\n";
sync_prompt += "Branch: " + branch + "\n";
sync_prompt += "Base ref to merge (NOT necessarily origin/master): " + base_ref + "\n";
sync_prompt += "1. git fetch origin\n";
sync_prompt += "2. If " + base_ref + " is NOT already an ancestor of HEAD, merge " + base_ref + " into HEAD.\n";
sync_prompt += "   Use the resolved remote-tracking base_ref exactly — do not substitute origin/master/main unless base_ref is that.\n";
sync_prompt += "   Resolve real conflicts properly — never paper over.\n";
sync_prompt += "3. Push the branch.\n";
sync_prompt += "4. Return ok=true only if merge (if needed) and push succeeded. ok=false on conflict/push failure.\n";
sync_prompt += "NEVER merge the PR to the default branch.\n";

let sync_r = agent(sync_prompt, #{
    label: "ship-sync",
    capability_mode: "all",
    output_schema: stage_schema,
});
if sync_r == () || !sync_r.success || sync_r.output == () || sync_r.output.ok != true {
    complete(#{
        ok: false,
        phase: "ship-sync",
        summary: "Ship sync failed — could not merge base_ref=" + base_ref + " or push.",
        pr_url: pr_url,
        branch: branch,
        detail: sync_r,
    });
}
log("ship-sync: " + sync_r.output.summary);

// CI and evidence are independent — fan out (Claude /be §5).
let ci_prompt = "";
ci_prompt += "You are the CI leg of grokbe ship (Claude /be §5 + odu skill). EXECUTE NOW.\n";
ci_prompt += "PR: " + pr_url + "  Branch: " + branch + "\n";
ci_prompt += "Read .claude/skills/odu/SKILL.md and .claude/skills/odu-mcp/SKILL.md and .agency/do.md CI section.\n";
ci_prompt += "Prefer the odu MCP tools (run → wait_for_settle fail-fast → read red log resource → node_rerun / fix / supersede).\n";
ci_prompt += "Fallback: nix run .#odu -- run (or nix run github:juspay/odu -- run) per the skill.\n";
ci_prompt += "Pin both platforms when the project is multi-platform. A single-platform green is a false green if both were required.\n";
ci_prompt += "On red: fix → fmt → commit → push → re-run/supersede. Loop until green or you are stuck on infra.\n";
ci_prompt += "Return ok=true only if CI is green on final HEAD. summary must include run identity (sha7/seq if any).\n";
ci_prompt += "Set ci_green accordingly. evidence_posted=false. pr_url=" + pr_url + "\n";

let evidence_prompt = "";
evidence_prompt += "You are the evidence leg of grokbe ship (Claude /be §5). EXECUTE NOW concurrently with CI.\n";
evidence_prompt += "PR: " + pr_url + "  Branch: " + branch + "  Task: " + task + "\n";
evidence_prompt += "Read .agency/do.md ## PR evidence and follow it exactly.\n";
evidence_prompt += "odu: terminal recording via asciinema → agg gif → evidence-assets release → ## Evidence PR comment.\n";
evidence_prompt += "Skip only if that section says to (or is absent) OR the change has no observable runtime behavior — say so in summary.\n";
evidence_prompt += "For bug fixes, demonstrate the now-fixed behavior even without a visual diff.\n";
evidence_prompt += "Return ok=true if evidence posted or correctly skipped. evidence_posted=true only if a comment/asset landed.\n";
evidence_prompt += "ci_green=false (you are not the CI leg). pr_url=" + pr_url + "\n";

let ship_jobs = [
    #{
        prompt: ci_prompt,
        label: "ship:ci",
        capability_mode: "all",
        output_schema: ship_schema,
    },
    #{
        prompt: evidence_prompt,
        label: "ship:evidence",
        capability_mode: "all",
        output_schema: ship_schema,
    },
];
let ship_results = parallel(ship_jobs);

ci_summary = "ci leg missing";
evidence_ok = false;
evidence_summary = "evidence leg missing";

if ship_results[0] != () && ship_results[0].success && ship_results[0].output != () {
    ci_ok = ship_results[0].output.ok == true && ship_results[0].output.ci_green == true;
    ci_summary = ship_results[0].output.summary;
}
if ship_results[1] != () && ship_results[1].success && ship_results[1].output != () {
    evidence_ok = ship_results[1].output.ok == true;
    evidence_summary = ship_results[1].output.summary;
    if ship_results[1].output.evidence_posted == true {
        evidence_posted = true;
    }
}

} else {
    phase("Ship");
    log("ship skipped — from=" + from_arg);
    // Gauntlet-only: CI/evidence not required; proof gates still apply below.
    ci_ok = true;
    evidence_ok = true;
}

// Final outcome: ship legs AND proof gates (codex consensus when selected, push when gauntlet ran).
let final_ok = ci_ok && evidence_ok && gauntlet_ok && push_ok;

// ── Done ─────────────────────────────────────────────────────────────────────

phase("Done");

let report = "";
report += "# grokbe complete\n\n";
report += "**PR:** " + pr_url + "\n";
report += "**Branch:** " + branch + "\n";
report += "**from:** " + from_arg + "\n";
report += "**Task:** " + task + "\n";
report += "**task_kind:** " + task_kind + "\n";
report += "**tracks:** " + tracks_csv + "\n";
report += "**ok:** " + bool_str(final_ok) + " (ci=" + bool_str(ci_ok) + " evidence=" + bool_str(evidence_ok) + " gauntlet=" + bool_str(gauntlet_ok) + " push=" + bool_str(push_ok) + ")\n\n";
report += "## Implementation\n" + impl_summary + "\n\n";
if plan_path != "" {
    report += "## Plan\n" + plan_path + " — " + plan_summary + "\n\n";
}
report += "## Gauntlet\n";
for note in gauntlet_notes {
    report += "- " + note + "\n";
}
report += "\n## Ship\n";
if do_ship {
    report += "- CI: " + ci_summary + " (green=" + bool_str(ci_ok) + ")\n";
    report += "- Evidence: " + evidence_summary + " (posted=" + bool_str(evidence_posted) + ")\n\n";
} else {
    report += "- skipped (from=" + from_arg + ")\n\n";
}
report += "## Notes\n";
report += "- Never merged — human reviews commits and merges when satisfied.\n";
if do_adversarial {
    report += "- Adversarial track runs real /codex-debate via Kolu (live codex --yolo, effort xhigh) — no substitute critic. Proof gate: consensus required when selected.\n";
}
if do_lens {
    report += "- Lens track runs lowy ∥ hickey independently, then one reconcile+apply editor.\n";
}
report += "- YOLO reviewer assumes a TRUSTED local branch (codex-debate skill honest limit) — not for untrusted third-party PRs.\n";

let report_path = write_scratch_file("grokbe-report.md", report);
log(report);

complete(#{
    ok: final_ok,
    pr_url: pr_url,
    pr_number: pr_number,
    branch: branch,
    task_kind: task_kind,
    tracks: tracks_csv,
    from: from_arg,
    gauntlet: gauntlet_notes,
    gauntlet_ok: gauntlet_ok,
    push_ok: push_ok,
    ci_green: ci_ok,
    evidence_posted: evidence_posted,
    report_path: report_path,
    summary: report,
});
