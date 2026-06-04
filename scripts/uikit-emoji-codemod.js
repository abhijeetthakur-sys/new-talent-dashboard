// uikit-emoji-codemod — replaces leading structural emojis in JSX text with
// <UiIcon icon="…"/> kit glyphs. Content emojis in data strings are untouched.
// Run: node scripts/uikit-emoji-codemod.js
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const FILE = path.join(__dirname, "..", "src", "App.jsx");

// emoji → covered by EMOJI_GLYPHS map in App.jsx (UiIcon resolves at runtime)
const MAPPED = new Set([
  "🏠","🎓","📚","🎤","🎵","🎼","💿","📅","🗓","✦","✨","💡","🧠","📊","📈","📋","📝","✏",
  "🗑","🎯","💬","🔍","⚙","🎛","🔔","📄","📃","🏆","🎉","⭐","🌟","⚡","🚀","📌","📍","🎟",
  "🎫","👥","👤","🔒","🔐","📹","🎬","👁","👍","⚠","☁","✅","❌",
]);

const src = fs.readFileSync(FILE, "utf8");
const ast = parser.parse(src, { sourceType: "module", plugins: ["jsx"] });

let count = 0;

function leadingEmoji(text) {
  // match first grapheme-ish token + optional variation selector
  const m = /^(\s*)((?:\uD83C|\uD83D|\uD83E)[\uDC00-\uDFFF]|[☀-➿✀-➿])(️)?(\s|$)/.exec(text);
  if (!m) return null;
  const emoji = m[2];
  if (!MAPPED.has(emoji)) return null;
  return { lead: m[1], emoji, rest: text.slice(m[0].length - m[4].length) };
}

traverse(ast, {
  JSXText(p) {
    const text = p.node.value;
    const hit = leadingEmoji(text);
    if (!hit) return;
    count++;
    const uiIcon = t.jsxExpressionContainer(
      t.jsxElement(
        t.jsxOpeningElement(t.jsxIdentifier("UiIcon"), [
          t.jsxAttribute(t.jsxIdentifier("icon"), t.stringLiteral(hit.emoji)),
          t.jsxAttribute(t.jsxIdentifier("size"), t.jsxExpressionContainer(t.numericLiteral(13))),
        ], true),
        null, [], true
      )
    );
    const nodes = [];
    if (hit.lead) nodes.push(t.jsxText(hit.lead));
    nodes.push(uiIcon);
    if (hit.rest.trim()) nodes.push(t.jsxText(" " + hit.rest.replace(/^\s+/, "")));
    else if (hit.rest) nodes.push(t.jsxText(hit.rest));
    p.replaceWithMultiple(nodes);
  },
});

const out = generate(ast, { retainLines: true, jsescOption: { minimal: true } }, src).code;
fs.writeFileSync(FILE, out, "utf8");
console.log("Replaced leading emojis in JSX text:", count);
