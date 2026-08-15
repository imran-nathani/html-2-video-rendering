/**
 * Single lazy import boundary for `@hyperframes/producer` (`00-PLAN.md` §3).
 * `@hyperframes/producer` cold-imports slowly, so no command loads it at
 * module scope — only `render` (and eventually `probe`/`lint`) calls this,
 * keeping `hfmpeg --help` / `version` / `doctor` instant.
 */
export async function loadProducer() {
  return import("@hyperframes/producer");
}
