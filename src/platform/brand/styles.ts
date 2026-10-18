/** Staff app stylesheet, served inline by page() in shell.ts (style-src allows inline styles; fonts come from this origin). */
const FONT_FILES = [
  ['Poppins', 500, 'poppins-500'],
  ['Poppins', 600, 'poppins-600'],
  ['Barlow', 400, 'barlow-400'],
  ['Barlow', 500, 'barlow-500'],
  ['Barlow', 600, 'barlow-600'],
] as const;

/** @font-face rules for the self-hosted brand fonts (brand/fonts.ts, served by shell.ts at <base>/assets/fonts/). */
const fontFaces = (base: string): string =>
  FONT_FILES.map(
    ([family, weight, file]) =>
      `@font-face{font-family:${family};font-style:normal;font-weight:${weight};font-display:swap;src:url(${base}/assets/fonts/${file}.woff2) format("woff2")}`
  ).join('\n');

/**
 * "Ledger" look (Oct 17, 2026): white page, ink text, Poppins headings, Barlow text, hairline tables, square buttons,
 * tags with a left bar. Blue = ok / filed / verified, gold = a person needs to look, red = errors only.
 * The older variable names (--muted, --accent, --urgent, --ok, --warn, ...) stay because screens use them inline.
 */
export const shellCss = (base: string): string => `
${fontFaces(base)}
:root{--white:#fff;--ink:#222236;--slate:#5A5C78;--line:#DCE3EA;--field:#767B95;--blue:#29AAE1;--blue-700:#0F6E9C;--blue-50:#EAF6FC;--navy:#3E3E84;
--gold:#C68010;--gold-700:#8A5A0B;--gold-50:#FBF1DF;--red:#B0301F;--red-50:#FCEBE8;
--bg:var(--white);--card:var(--white);--muted:var(--slate);--brand:var(--ink);--accent:var(--blue-700);
--urgent:var(--red);--urgent-bg:var(--red-50);--ok:var(--blue-700);--ok-bg:var(--blue-50);--warn:var(--gold-700);--warn-bg:var(--gold-50);
--display:Poppins,"Segoe UI",system-ui,sans-serif;--text:Barlow,"Segoe UI",system-ui,sans-serif;--ease:cubic-bezier(.22,.7,.16,1);--gutter:max(16px,calc(50% - 600px))}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--white);color:var(--ink);font:500 16px/1.55 var(--text);font-variant-ligatures:no-common-ligatures no-contextual}
header{display:flex;align-items:center;gap:10px 20px;flex-wrap:wrap;padding:14px var(--gutter);border-top:4px solid var(--blue);border-bottom:1px solid var(--line);background:var(--white)}
header .brand{--h:46px;display:grid;flex:0 1 auto;min-width:0}
header .brand>svg{grid-area:1/1;height:var(--h);width:auto}
header .brand .org{grid-area:1/1;align-self:end;margin-left:calc(var(--h)*1.2028);margin-bottom:-.15em;font:500 calc(var(--h)*.262)/1.3 var(--display);letter-spacing:.01em;color:var(--slate);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:calc(100vw - 32px - var(--h)*1.2028)}
header .sp{flex:1}header .who{font-size:14px;color:var(--slate)}
nav.tabs{display:flex;gap:0 24px;flex-wrap:wrap;padding:0 var(--gutter);background:var(--white);border-bottom:1px solid var(--line)}
nav.tabs a{padding:13px 0 11px;color:var(--slate);text-decoration:none;border-bottom:2px solid transparent;font:500 14px/1.2 var(--display);transition:color .15s var(--ease),border-color .15s var(--ease)}
nav.tabs a:hover{color:var(--ink)}nav.tabs a.on{color:var(--ink);border-bottom-color:var(--blue)}
main{max-width:1248px;margin:0 auto;padding:24px 24px 64px}a{color:var(--blue-700);text-underline-offset:2px}
h1,h2,h3{font-family:var(--display);font-weight:500;letter-spacing:-.02em;color:var(--ink)}
h2{font-size:20px;line-height:1.25;margin:28px 0 12px}main>h2:first-child{font-size:26px;letter-spacing:-.03em}
h3{font-size:16px;line-height:1.3;margin:16px 0 8px;letter-spacing:-.01em}
.notice{padding:10px var(--gutter);font-weight:600;border-bottom:1px solid var(--line)}
.notice.urgent{background:var(--red-50);color:var(--red);box-shadow:inset 4px 0 0 var(--red)}
.card{background:var(--white);border:1px solid var(--line);border-radius:2px;padding:16px 18px;margin-bottom:12px}
.card[style*="border-color"]{border-left-width:3px}
a.card{color:inherit;transition:border-color .15s var(--ease)}a.card:hover{border-color:var(--ink)}
a.card strong{font:500 17px/1.3 var(--display);letter-spacing:-.01em}
.signin{max-width:400px;margin:48px auto;padding:28px;border-top:3px solid var(--ink)}.signin h2{font-size:26px;letter-spacing:-.03em}
.signin button{width:100%;margin-top:4px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;text-decoration:none;color:inherit}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.pill{display:inline-flex;align-items:center;font:600 12px/1.25 var(--display);letter-spacing:.01em;padding:3px 8px 3px 7px;border-left:3px solid #9AA0B4;border-radius:0 2px 2px 0;background:#F2F4F7;color:var(--slate)}
.pill.ok{border-left-color:var(--blue);background:var(--blue-50);color:var(--ink)}
.pill.warn{border-left-color:var(--gold);background:var(--gold-50);color:var(--gold-700)}
.pill.urgent{border-left-color:var(--red);background:var(--red-50);color:var(--red)}
.muted{color:var(--slate)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:0}dt{color:var(--slate)}dd{margin:0;overflow-wrap:anywhere}
ul{margin:4px 0 0;padding-left:18px}
table{width:100%;border-collapse:collapse;font-size:15px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:9px 12px 9px 0;border-bottom:1px solid var(--line);vertical-align:top}th:first-child,td:first-child{padding-left:12px}
th{font:600 13px/1.3 var(--text);letter-spacing:.02em;color:var(--slate);background:var(--blue-50)}
.scroll{overflow-x:auto}
button,input,select,textarea{font:inherit}
button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:8px 16px;border:0;border-radius:2px;background:var(--ink);color:#fff;font:500 14px/1.2 var(--display);cursor:pointer;transition:background .15s var(--ease)}
button:hover{background:var(--navy)}button:disabled{opacity:.5;cursor:not-allowed}form>button+span.muted{margin-left:6px}
button.secondary{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--ink)}button.secondary:hover{background:var(--blue-50)}
button.link{background:none;color:var(--slate);padding:0;min-height:0;text-decoration:underline;text-underline-offset:2px;font:500 14px/1.2 var(--text)}button.link:hover{color:var(--ink)}
input,select,textarea{width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--field);border-radius:2px;background:var(--white);color:var(--ink);font:500 15px/1.4 var(--text)}
input[type=checkbox],input[type=radio]{margin-top:0;accent-color:var(--blue-700)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
.empty{text-align:center;padding:40px 16px}.stat{font:500 30px/1.15 var(--display);letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:640px){header .brand{--h:40px}main{padding:16px 16px 48px}h2{font-size:18px}main>h2:first-child,.signin h2{font-size:22px}nav.tabs{gap:0 18px}.signin{margin:24px auto;padding:20px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;
