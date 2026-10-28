/**
 * Deterministic site builder — the demo "agent" until a real harness plugs in.
 * A per-binding SiteSpec is mutated by plain-language instructions, rendered
 * to HTML, written to the computer's disk, and opened/reloaded in Chromium.
 */

export interface SiteSpec {
  title: string;
  tagline: string;
  bg: string;
  fg: string;
  accent: string;
  menu: string[];
  sections: { heading: string; body: string }[];
  updatedAt: string;
}

const COLORS: Record<string, string> = {
  navy: "#0a1a2f", black: "#111111", white: "#f7f7f5", cream: "#f4ead8",
  green: "#123524", red: "#3d1414", purple: "#241a3d", gray: "#222630",
  grey: "#222630", dark: "#101418",
};

export function newSite(name: string): SiteSpec {
  return {
    title: name.replace(/\b\w/g, (c) => c.toUpperCase()),
    tagline: "Something worth visiting.",
    bg: "#0a1a2f",
    fg: "#f4ead8",
    accent: "#c8a97e",
    menu: [],
    sections: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Apply every matching part of a plain-language instruction. Returns notes. */
export function applyInstruction(spec: SiteSpec, text: string): string {
  const notes: string[] = [];
  // compound instructions split on "and" so each clause matches independently
  for (const clause of text.split(/\s+and\s+/i)) {
    applyClause(spec, clause.toLowerCase().trim(), notes);
  }
  return notes.join("; ");
}

function applyClause(spec: SiteSpec, t: string, notes: string[]): void {
  if (!t) return;
  // navigation filler ("open it", "show it") carries no edit — skip silently
  if (/^(open|show|launch|view|load|see)\s+(it|this|the\s+(page|site|website))?[\s.!]*$/.test(t)) return;
  let matched = false;

  const build = t.match(/(?:build|make|create|open)\s+(?:a\s+|an\s+)?(?:simple\s+)?(?:page|site|website|landing)\s+(?:for|called|named)\s+(.+)/);
  if (build) {
    const name = build[1].trim().replace(/[.?!]+$/, "");
    const fresh = newSite(name);
    Object.assign(spec, fresh);
    spec.tagline = "Built live from iMessage.";
    notes.push(`built a page for ${spec.title}`);
    return;
  }

  const bg = t.match(/(?:background|bg|color|colour)[a-z\s]*?(?:to|=|:)?\s*(navy|black|white|cream|green|red|purple|gr[ae]y|dark|#[0-9a-f]{3,8})/)
        ?? t.match(/make (?:it|the (?:page|site|background)) (navy|black|white|cream|green|red|purple|gr[ae]y|dark)/);
  if (bg) {
    spec.bg = COLORS[bg[1]] ?? bg[1];
    spec.fg = spec.bg === COLORS.white || spec.bg === COLORS.cream ? "#1a1a1a" : "#f4ead8";
    notes.push(`background → ${spec.bg}`);
    matched = true;
  }

  if (/add (a )?menu/.test(t)) {
    spec.menu = ["Home", "Menu", "About", "Visit"];
    notes.push("added a menu");
    matched = true;
  } else {
    const addItem = t.match(/add ["']?([^"'.]+?)["']? to (?:the )?menu/);
    if (addItem) {
      spec.menu.push(addItem[1].trim());
      notes.push(`added "${addItem[1].trim()}" to the menu`);
      matched = true;
    }
  }

  const tag = t.match(/(?:tagline|slogan|subtitle)[a-z\s]*(?:to|=|:)\s*["']?(.+?)["']?$/);
  if (tag) {
    spec.tagline = tag[1].trim();
    notes.push(`tagline → "${spec.tagline}"`);
    matched = true;
  }

  const section = t.match(/add (?:a |an )?(.+?) section/);
  if (section) {
    const heading = section[1].trim();
    spec.sections.push({ heading, body: `${spec.title} — ${heading}. Added from a follow-up text.` });
    notes.push(`added a ${heading} section`);
    matched = true;
  }

  if (/accent|highlight/.test(t)) {
    spec.accent = spec.accent === "#c8a97e" ? "#7ec8e3" : "#c8a97e";
    notes.push(`accent → ${spec.accent}`);
    matched = true;
  }

  if (!matched) {
    // fallback: record the request visibly on the page
    spec.sections.push({ heading: "Requested", body: `“${t.trim()}”` });
    notes.push("noted the request on the page");
  }
}

export function renderSite(spec: SiteSpec): string {
  const menu = spec.menu.length
    ? `<nav>${spec.menu.map((m) => `<a href="#">${esc(m)}</a>`).join("")}</nav>`
    : "";
  const sections = spec.sections
    .map((s) => `<section><h2>${esc(s.heading)}</h2><p>${esc(s.body)}</p></section>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(spec.title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:${spec.bg};color:${spec.fg};font-family:Georgia,'Times New Roman',serif;min-height:100vh;display:flex;flex-direction:column}
nav{display:flex;gap:28px;justify-content:center;padding:18px;border-bottom:1px solid ${spec.accent}33}
nav a{color:${spec.accent};text-decoration:none;font-family:-apple-system,system-ui,sans-serif;font-size:14px;letter-spacing:2px;text-transform:uppercase}
.hero{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 20px}
.tag{letter-spacing:4px;text-transform:uppercase;font-size:12px;color:${spec.accent};font-family:-apple-system,system-ui,sans-serif}
h1{font-size:52px;margin:12px 0 8px;font-weight:600}
.hero p{color:${spec.accent};font-size:20px;margin:0}
section{max-width:640px;margin:24px auto;padding:0 24px;text-align:center}
section h2{color:${spec.accent};font-size:22px;letter-spacing:1px}
section p{color:${spec.fg};opacity:.85;font-size:16px;line-height:1.6}
footer{text-align:center;padding:16px;font-size:11px;color:${spec.accent}99;font-family:-apple-system,system-ui,sans-serif}
</style></head>
<body>${menu}<div class="hero"><div class="tag">est. 2026 · built inside imessage</div><h1>${esc(spec.title)}</h1><p>${esc(spec.tagline)}</p></div>${sections}<footer>updated ${esc(spec.updatedAt.slice(11, 19))}Z · served from a Maritime computer</footer></body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
