// PostToolUse hook (Write|Edit): reminds the agent to apply the repo's
// "Documentation sync rule" whenever a source file changes.
// Reads the hook payload JSON on stdin; emits additionalContext JSON on stdout.
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
  if (/psc-archiver-api\//i.test(file)) {
    docs =
      "psc-archiver-api docs — endpoints/guards: doc/02-modules.md; schemas: doc/03-data-model.md; auth: doc/04-auth.md; enums/permissions: lists in doc/02-modules.md + CLAUDE.md + AGENTS.md; completed planned work: doc/07-future-work.md";
  } else if (/psc-archiver-admin\//i.test(file)) {
    docs =
      "psc-archiver-admin docs — the matching docs/arch/* file for the area, docs/features/* status if feature scope changed, and docs/arch/11-shared-atoms-manifest.md if a shared atom was added/changed";
  } else {
    return;
  }

  console.log(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `Doc-sync reminder: ${file} changed. Per the Documentation sync rule in CLAUDE.md, update the matching documentation in this same change (${docs}) — or note explicitly that no doc covers this change.`,
      },
    }),
  );
});
