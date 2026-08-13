// PostToolUse hook (Write|Edit): reminds the agent to apply the repo's
// "Documentation sync rule" whenever a source file changes, and — in the two
// frontends — the no-em-dash copy rule that `pnpm check:copy` enforces.
// Reads the hook payload JSON on stdin; emits additionalContext JSON on stdout.
//
// Advisory only. It never blocks a write: `check:copy` is the hard gate, and a
// hook that fails a save would punish the agent for a rule it can still fix.
//
// Four identical copies of this file exist — one per repo plus the workspace
// root — each wired by that repo's .claude/settings.json. They are hand-kept
// duplicates, not symlinks: a change here must be copied to the other three.
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const file = String(payload?.tool_input?.file_path ?? "").replace(/\\/g, "/");
  if (!/\/src\/.+\.(ts|tsx|js|jsx|css)$/i.test(file)) return;
  if (/node_modules|\/dist\//i.test(file)) return;

  let docs;
  let copyRule = "";
  if (/psc-archiver-api\//i.test(file)) {
    docs =
      "psc-archiver-api docs — endpoints/guards: doc/02-modules.md; schemas: doc/03-data-model.md; auth: doc/04-auth.md; enums/permissions: lists in doc/02-modules.md + CLAUDE.md + AGENTS.md; completed planned work: doc/07-future-work.md";
    copyRule =
      " If this change added or edited an exception message (BadRequestException / ConflictException / ForbiddenException), remember it renders verbatim in a frontend toast: no em dashes, no schema field names.";
  } else if (/psc-archiver-admin\//i.test(file)) {
    docs =
      "psc-archiver-admin docs — the matching docs/arch/* file for the area, docs/features/* status if feature scope changed, and docs/arch/11-shared-atoms-manifest.md if a shared atom was added/changed";
    copyRule =
      " If this change touched any user-visible string, apply docs/arch/12-user-facing-copy.md — no em dashes in copy (a comma, a colon, parentheses, or two sentences instead) — and run `pnpm check:copy`.";
  } else if (/psc-archiver-client\//i.test(file)) {
    docs =
      "psc-archiver-client docs — the matching docs/arch/* file for the area, docs/features/* status if feature scope changed, and docs/arch/11-shared-atoms-manifest.md if a shared atom was added/changed";
    copyRule =
      " If this change touched any user-visible string, apply docs/arch/12-user-facing-copy.md — no em dashes in copy (a comma, a colon, parentheses, or two sentences instead) — and run `pnpm check:copy`.";
  } else {
    return;
  }

  console.log(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `Doc-sync reminder: ${file} changed. Per the Documentation sync rule in CLAUDE.md, update the matching documentation in this same change (${docs}) — or note explicitly that no doc covers this change.${copyRule}`,
      },
    }),
  );
});
