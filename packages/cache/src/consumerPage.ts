import {
  actionsBlock,
  FLAKE_CONFIG_NOTE,
  flakeBlock,
  MACHINE_CONFIG_NOTE,
  netrcBlock,
  nixConfBlock,
  nixOsBlock,
  pushBlock,
  PLACEHOLDER_HOME,
  type CacheBucketIdentity,
} from "./surface";

export interface ConsumerFacts extends Omit<CacheBucketIdentity, "readsFrom"> {
  readonly upstreamKeys: readonly string[];
  readonly use: string;
  readonly command: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function consumerPage(facts: ConsumerFacts): string {
  const blocks: ReadonlyArray<readonly [string, string, string?]> = [
    ["nix.conf", nixConfBlock(facts)],
    ["NixOS / nix-darwin", nixOsBlock(facts)],
    ["flake.nix", flakeBlock(facts), FLAKE_CONFIG_NOTE],
    ["GitHub Actions", actionsBlock(facts)],
    ...(facts.public
      ? []
      : [["netrc", netrcBlock({ url: facts.url, home: PLACEHOLDER_HOME })] as const]),
  ];
  const block = (title: string, text: string, note?: string): string =>
    `<h3>${escapeHtml(title)}</h3>${note === undefined ? "" : `
<p class="hint">${escapeHtml(note)}</p>`}
<div class="block"><button type="button" data-copy>copy</button><pre>${escapeHtml(text)}</pre></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(facts.name)} — an odu bucket</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>/* NIGHT SHIFT, SPELLED OUT. This page ships no stylesheet — it is served
   at a bucket's own domain to a reader who has no board — so the design
   system's tokens are hard-coded here rather than imported. The values are
   the theme.css table of @odu/face, dark half first (dark wins a tie there
   too) and the light half under prefers-color-scheme. Colour carries STATUS
   on the board; this page has no status, so its only hue is the link's. */
:root{
  color-scheme:dark light;
  --canvas:#0a0d0c;--panel:#0d1210;--sunken:#070908;--line:#1c2420;--line-strong:#2a342f;
  --ink:#e6ede9;--ink-2:#c9d4ce;--muted:#93a39b;--quiet:#7a8982;--cyan:#3fd0de;
  --mono:"Geist Mono",ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
  --sans:"Geist",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
@media (prefers-color-scheme: light){:root{
  --canvas:#f4f7f5;--panel:#ffffff;--line:#dde5e0;--line-strong:#c3d0c9;
  --ink:#10201a;--ink-2:#2b3a33;--muted:#48584f;--quiet:#5d6d66;--cyan:#0a7385;
}}
*{box-sizing:border-box}
body{max-width:52rem;margin:0 auto;padding:3rem 1.25rem 4rem;background:var(--canvas);color:var(--ink);font:0.95rem/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--cyan)}
:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
/* The name is a string a machine chose, so it is mono — the same rule the
   board's bucket page keeps for its own title. */
h1{margin:0 0 .4rem;font:600 2rem/1.2 var(--mono);letter-spacing:-.03em;overflow-wrap:anywhere}
h2{margin:2.25rem 0 .6rem;font:600 1.05rem var(--sans);letter-spacing:-.01em}
h3{margin:1.4rem 0 .4rem;font:500 .8rem var(--mono);color:var(--muted)}
p{margin:0 0 .7rem;color:var(--muted)}
code{font:.82rem var(--mono);color:var(--ink-2);overflow-wrap:anywhere}
/* The facts a client trusts this bucket by: one panel, a hairline per row. */
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);margin:1.25rem 0 0;border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}
dt{padding:.7rem 1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.8rem}
dd{margin:0;padding:.7rem 1rem;border-top:1px solid var(--line);min-width:0;overflow-wrap:anywhere}
dl>dt:first-child,dl>dt:first-child+dd{border-top:0}
/* A snippet is copied, so it is never re-wrapped: it scrolls inside its own
   box and the PAGE never scrolls sideways, which is what makes this readable
   on a phone. The sunken surface stays dark in both themes — a terminal is a
   terminal. */
pre{margin:0;padding:1rem 1.1rem;background:var(--sunken);color:#c9d4ce;font:.78rem/1.7 var(--mono);overflow-x:auto;white-space:pre;scrollbar-width:thin}
.block{position:relative;margin:.4rem 0 1rem;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.block pre{padding:2.7rem 1.1rem 1rem}
[data-copy]{position:absolute;top:.5rem;right:.5rem;min-height:2rem;padding:0 .7rem;border:1px solid var(--line-strong);border-radius:9px;background:var(--panel);color:var(--ink);font:500 .75rem var(--mono);cursor:pointer}
[data-copy]:hover{border-color:var(--cyan)}
.hint{font-size:.85rem}
.served{margin:2.5rem 0 0;padding-top:1rem;border-top:1px solid var(--line);color:var(--quiet);font:.78rem var(--mono)}
</style></head>
<body>
<h1>${escapeHtml(facts.name)}</h1>
<p>${facts.public ? "A public bucket." : "A private bucket — this page was answered to a reader."}</p>
<dl>
<dt>Substituter</dt><dd><code>${escapeHtml(facts.url)}</code> · <a href="${escapeHtml(
    `${facts.url.replace(/\/$/, "")}/nix-cache-info`,
  )}">nix-cache-info</a></dd>
<dt>Public key</dt><dd><code>${escapeHtml(facts.publicKey)}</code></dd>
<dt>Upstream keys</dt><dd><code>${escapeHtml(facts.upstreamKeys.join(" ") || "(none)")}</code></dd>
</dl>
<h2>Use it</h2>
<p class="hint">${escapeHtml(MACHINE_CONFIG_NOTE)}</p>
${blocks.map(([title, text, note]) => block(title, text, note)).join("\n")}
<p class="hint">Or let a terminal print them: <code>${escapeHtml(facts.command)}</code></p>
<h2>Push to it</h2>
<p class="hint">A write token comes from this bucket's page on the board — an admin mints one. The push exports it where the build runs.</p>
${block("push", pushBlock({ url: facts.url, token: null }))}
<script>
document.addEventListener("click", function (event) {
  var button = event.target.closest("[data-copy]");
  if (!button) return;
  var pre = button.parentElement.querySelector("pre");
  navigator.clipboard.writeText(pre.textContent).then(function () {
    button.textContent = "copied";
    setTimeout(function () { button.textContent = "copy"; }, 1200);
  });
});
</script>
<p class="served">served by <a href="https://odu.kolu.dev/">odu</a></p>
</body></html>
`;
}
