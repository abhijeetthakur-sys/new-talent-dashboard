// uikit-theme-codemod v3 — proper Babel AST transform.
// Sweeps hardcoded light-theme hex literals to C.* theme tokens so the ui-kit
// day/night theme applies across the whole app. Skips: theme token blocks,
// embedded HTML export documents (PDF/print templates).
// Run: node scripts/uikit-theme-codemod.js
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const FILE = path.join(__dirname, "..", "src", "App.jsx");

const MAP = {
  "#fbf8f2": "card",
  "#f6f1e8": "hi",
  "#eae3d6": "hi2",
  "#f1ece2": "bg",
  "#efe9dd": "hi",
  "#ded6c7": "border",
  "#cfc6b5": "borderHi",
  "#e5e7eb": "border",
  "#15120d": "ink",
  "#4a4234": "sec",
  "#6f6657": "muted",
  "#a99e8b": "faint",
  "#9ca3af": "faint",
  "#bebebe": "faint",
  "#e0531f": "acc",
  "#b8431a": "accDeep",
  "#d4501e": "orange",
  "#6b3fa0": "pink",
  "#1f6f5c": "teal",
  "#0f766e": "teal",
  "#047857": "ok",
  "#10b981": "ok",
  "#059669": "okDeep",
  "#065f46": "okDeep",
  "#dc2626": "err",
  "#ef4444": "err",
  "#b45309": "warn",
  "#f59e0b": "warn",
  "#d97706": "warn",
  "#c98a1a": "warn",
};
const WHITES = new Set(["#fff", "#ffffff"]);
const BG_PROPS = new Set(["background", "backgroundColor"]);
const HEX_RE = /#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b/g;

const src = fs.readFileSync(FILE, "utf8");

// skip ranges: theme token blocks
const skipRanges = [];
for (const [s, e] of [
  ["/*__THEME_TOKENS_START__*/", "/*__THEME_TOKENS_END__*/"],
  ["/*__STATUS_TOKENS_START__*/", "/*__STATUS_TOKENS_END__*/"],
]) {
  const i = src.indexOf(s);
  if (i === -1) continue;
  const j = src.indexOf(e, i);
  if (j === -1) continue;
  skipRanges.push([i, j + e.length]);
}
const inSkip = (node) =>
  node.start != null && skipRanges.some(([a, b]) => node.start >= a && node.start < b);

const cTok = (name) => t.memberExpression(t.identifier("C"), t.identifier(name));
const tokenFor = (hex) => MAP[hex.toLowerCase()] || null;

const stats = { exact: 0, jsxAttr: 0, composite: 0, tplText: 0, bgWhite: 0, htmlDocSkipped: 0 };

const ast = parser.parse(src, {
  sourceType: "module",
  plugins: ["jsx"],
});

function buildTemplateFromString(value) {
  // split into quasis + C.* expressions
  HEX_RE.lastIndex = 0;
  const parts = [];
  let last = 0;
  let m;
  let any = false;
  while ((m = HEX_RE.exec(value))) {
    const tok = tokenFor(m[0]);
    if (!tok) continue;
    parts.push({ text: value.slice(last, m.index) });
    parts.push({ expr: tok });
    last = m.index + m[0].length;
    any = true;
  }
  if (!any) return null;
  parts.push({ text: value.slice(last) });
  const quasis = [];
  const exprs = [];
  let pendingText = "";
  for (const p of parts) {
    if (p.text !== undefined) pendingText += p.text;
    else {
      quasis.push(t.templateElement({ raw: pendingText.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"), cooked: pendingText }, false));
      exprs.push(cTok(p.expr));
      pendingText = "";
    }
  }
  quasis.push(t.templateElement({ raw: pendingText.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"), cooked: pendingText }, true));
  return t.templateLiteral(quasis, exprs);
}

traverse(ast, {
  StringLiteral(path) {
    const node = path.node;
    if (inSkip(node)) return;
    const v = node.value;
    const lower = v.toLowerCase();

    // background:"#fff" → C.card (object property values only)
    if (WHITES.has(lower)) {
      const parent = path.parent;
      if (
        t.isObjectProperty(parent) &&
        parent.value === node &&
        ((t.isIdentifier(parent.key) && BG_PROPS.has(parent.key.name)) ||
          (t.isStringLiteral(parent.key) && BG_PROPS.has(parent.key.value)))
      ) {
        stats.bgWhite++;
        path.replaceWith(cTok("card"));
      }
      return;
    }

    // exact hex
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
      const tok = tokenFor(v);
      if (!tok) return;
      if (t.isJSXAttribute(path.parent)) {
        stats.jsxAttr++;
        path.replaceWith(t.jsxExpressionContainer(cTok(tok)));
      } else {
        stats.exact++;
        path.replaceWith(cTok(tok));
      }
      return;
    }

    // composite string containing mapped hex
    HEX_RE.lastIndex = 0;
    if (HEX_RE.test(v)) {
      const tpl = buildTemplateFromString(v);
      if (!tpl) return;
      stats.composite++;
      if (t.isJSXAttribute(path.parent)) {
        path.replaceWith(t.jsxExpressionContainer(tpl));
      } else {
        path.replaceWith(tpl);
      }
    }
  },

  TemplateLiteral(path) {
    const node = path.node;
    if (inSkip(node)) return;
    // skip embedded HTML documents (PDF/print exports) entirely
    const head = (node.quasis[0]?.value.cooked || "").slice(0, 400).toLowerCase();
    if (head.includes("<!doctype") || head.includes("<html")) {
      stats.htmlDocSkipped++;
      path.skip();
      return;
    }
    // Build flat interleaved list [text, expr, text, expr, ..., text],
    // splitting any quasi text that contains mapped hexes.
    let changed = false;
    const flat = []; // items: {text} or {node: expressionNode}
    for (let qi = 0; qi < node.quasis.length; qi++) {
      const text = node.quasis[qi].value.cooked ?? node.quasis[qi].value.raw;
      HEX_RE.lastIndex = 0;
      let m;
      let last = 0;
      while ((m = HEX_RE.exec(text))) {
        const tok = tokenFor(m[0]);
        if (!tok) continue;
        flat.push({ text: text.slice(last, m.index) });
        flat.push({ node: cTok(tok) });
        last = m.index + m[0].length;
        changed = true;
        stats.tplText++;
      }
      flat.push({ text: text.slice(last) });
      if (qi < node.expressions.length) flat.push({ node: node.expressions[qi] });
    }
    if (!changed) return;
    // Reassemble: merge consecutive texts; alternate text/expr; ends with text.
    const mq = [];
    const me = [];
    let pendingText = "";
    const mkElem = (txt, tail) =>
      t.templateElement({ raw: txt.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"), cooked: txt }, tail);
    for (const item of flat) {
      if (item.text !== undefined) { pendingText += item.text; continue; }
      mq.push(mkElem(pendingText, false));
      me.push(item.node);
      pendingText = "";
    }
    mq.push(mkElem(pendingText, true));
    path.replaceWith(t.templateLiteral(mq, me));
    path.skip();
  },
});

const output = generate(ast, { retainLines: true, jsescOption: { minimal: true } }, src).code;
fs.writeFileSync(FILE, output, "utf8");
console.log("Done.", JSON.stringify(stats, null, 2));

const leftover = {};
for (const h of Object.keys(MAP)) {
  const re = new RegExp(h.replace("#", "#"), "gi");
  const c = (output.match(re) || []).length;
  if (c > 0) leftover[h] = c;
}
console.log("Leftovers (theme block + html docs):", JSON.stringify(leftover, null, 2));
