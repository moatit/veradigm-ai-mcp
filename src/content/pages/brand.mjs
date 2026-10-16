// Internal brand-kit page for review (noindex, not in the sitemap). Mirrors brand/BRAND_KIT.md.
import { pageHero } from "../layout.mjs";
import { btnPrimary } from "../partials.mjs";

export const PALETTE = [
  { cls: "indigo", name: "MOATiT Indigo", hex: "#3E3E85", use: "Primary brand. Wordmark, headings accents, buttons on light. From the MOATiT logo wordmark." },
  { cls: "sky", name: "MOATiT Sky", hex: "#29ABE2", use: "Accent. Chain, moat, highlights on dark. From the MOATiT logo arc and site CSS." },
  { cls: "amber", name: "MOATiT Amber", hex: "#F5A623", use: "Call to action, the hinge pin. From moatit.com CSS." },
  { cls: "signal", name: "MOATiT Signal", hex: "#D64534", use: "Critical / error states only. From the MOATiT logo arc." },
  { cls: "shield", name: "MOATiT Shield", hex: "#4981B5", use: "Secondary blue for charts and diagrams. From the MOATiT logo shield." },
  { cls: "night", name: "Drawbridge Night", hex: "#1C1C45", use: "Dark surfaces, hero, footer. Deepened MOATiT Indigo." },
  { cls: "sky700", name: "Sky 700", hex: "#0F6E9C", use: "Links and small accent text on light (AA). From moatit.com CSS." },
  { cls: "paper", name: "Paper", hex: "#F7F5F0", use: "Page background." },
  { cls: "ink", name: "Ink", hex: "#16163A", use: "Body text." },
];

export const brand = {
  path: "/brand/",
  title: "Brand kit",
  description: "Drawbridge — A MOATiT Service brand kit: logo lockups, colors and type. Internal review page.",
  noindex: true,
  sitemap: false,
  body: `${pageHero({
    eyebrow: "Brand kit · internal",
    title: 'Drawbridge — <span class="accent-i">A MOATiT Service</span>',
    lede: "Logo lockups, palette and type for review. Source files: brand/logo/*.svg. Usage rules: brand/BRAND_KIT.md.",
  })}
<section class="section">
  <div class="wrap">
    <h2>Lockups</h2>
    <div class="grid grid-2">
      <div class="logo-tile"><img src="/assets/brand/drawbridge-lockup.svg" width="243" height="82" alt="Primary horizontal lockup"></div>
      <div class="logo-tile dark"><img src="/assets/brand/drawbridge-lockup-reverse.svg" width="243" height="82" alt="Reverse horizontal lockup"></div>
      <div class="logo-tile"><img src="/assets/brand/drawbridge-lockup-stacked.svg" width="240" height="188" alt="Stacked lockup"></div>
      <div class="logo-tile dark"><img src="/assets/brand/drawbridge-lockup-stacked-reverse.svg" width="240" height="188" alt="Stacked reverse lockup"></div>
      <div class="logo-tile"><img src="/assets/brand/drawbridge-mark.svg" width="120" height="120" alt="Mark"></div>
      <div class="logo-tile"><img src="/assets/brand/favicon.svg" width="96" height="96" alt="App icon"></div>
    </div>
    <h2 class="mt-3">Palette</h2>
    <div class="brand-swatches">
      ${PALETTE.map((c) => `<div class="swatch"><div class="chip chip-${c.cls}"></div><div class="info"><b>${c.name}</b><span class="mono">${c.hex}</span><br>${c.use}</div></div>`).join("")}
    </div>
    <h2 class="mt-3">Type</h2>
    <div class="grid grid-3">
      <div class="card"><p class="eyebrow">Display</p><p class="h3like mb-0">Newsreader 560</p><p>Headlines; italic for the one emphasized phrase.</p></div>
      <div class="card"><p class="eyebrow">Body</p><p><strong>Public Sans</strong> 400 / 600 / 700. Body, UI, forms.</p></div>
      <div class="card"><p class="eyebrow">Labels</p><p class="mono">IBM Plex Mono 500</p><p>Section indexes, sample labels, data.</p></div>
    </div>
    <div class="btn-row mt-2">${btnPrimary()}</div>
  </div>
</section>`,
};
