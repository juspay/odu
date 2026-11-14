// The docs lint: the [lint] rules of the writing standard
// (dev/skills/docs-writing/SKILL.md), over every page under
// src/content/docs, recursively. One test per page, named by its slug
// (`your-repository`, `cache/push`), so a single page runs with
// `node --test --test-name-pattern='<slug>' test/docs-lint.test.mjs`.
//
// There is no exemption list and no per-page override: every page is held to
// every limit.
//
// Pages are parsed with satteri's `markdownToMdast`, resolved through
// astro → @astrojs/markdown-satteri → satteri, so a table, a list item or a
// raw HTML tag is exactly what the build sees.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const fromAstro = createRequire(
  createRequire(import.meta.url).resolve("astro/package.json"),
);
const fromSatteri = createRequire(fromAstro.resolve("@astrojs/markdown-satteri"));
const { markdownToMdast } = await import(
  pathToFileURL(fromSatteri.resolve("satteri")).href
);

const LIMITS = {
  blockWords: 80,
  cellWords: 40,
  sectionWords: 300,
  pageWords: 2500,
  sentenceWords: 40,
  dashesPerSentence: 1,
  semicolonsPerSentence: 1,
  descriptionChars: 160,
};

const contentDir = fileURLToPath(new URL("../src/content/docs/", import.meta.url));

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** Every `.md` under `dir`, as paths relative to it, sorted. */
function pagesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

// The frontmatter is four flat `key: value` lines (the collection's schema
// checks their types at build), so a YAML library is not needed to read them.
function parseFlatYaml(text) {
  const data = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^".*"$/.test(value)) value = JSON.parse(value);
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    data[match[1]] = value;
  }
  return data;
}

/** Split `---` frontmatter from the body; `offset` is the body's first line. */
function splitFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (!match) throw new Error("page has no frontmatter");
  const offset = match[0].split("\n").length - 1;
  return {
    data: parseFlatYaml(match[1]),
    body: source.slice(match[0].length),
    offset,
  };
}

// Inline code stands in as one neutral token per word, so its words count but
// its punctuation (`--flag`, `a.b`, `;`) never reads as a dash, a semicolon or
// a sentence end. The token is capitalized so a sentence that opens with code
// still starts a new sentence. Raw HTML (an anchor span, a `<kbd>` tag) is not
// running text, but the text between a `<kbd>` pair is.
function plain(node) {
  if (node.type === "inlineCode")
    return node.value
      .split(/\s+/)
      .filter(Boolean)
      .map(() => "X")
      .join(" ");
  if (node.type === "text") return node.value;
  if (node.type === "break") return " ";
  if (node.type === "image" || node.type === "html") return "";
  if (!node.children) return "";
  return node.children.map(plain).join("");
}

const words = (text) =>
  text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// "odu" is written lower case even at the start of a sentence (house style),
// which the segmenter would read as a continuation, so it segments a copy with
// the word capitalized. Word counts are unaffected.
function sentencesOf(text) {
  const flat = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bodu\b/g, "Odu");
  return [...sentences.segment(flat)]
    .map((s) => s.segment.trim())
    .filter(Boolean);
}

/** Every violation on one page, as `line N: message` strings. */
function lintPage({ data, body, offset }) {
  const problems = [];
  const at = (node) =>
    node.position ? node.position.start.line + offset : "?";
  const report = (node, message) =>
    problems.push(`line ${at(node)}: ${message}`);

  const description = data?.description;
  if (typeof description !== "string" || description.trim() === "") {
    problems.push("frontmatter: description is missing");
  } else {
    if (description.length > LIMITS.descriptionChars)
      problems.push(
        `frontmatter: description is ${description.length} characters (limit ${LIMITS.descriptionChars})`,
      );
    if (sentencesOf(description).length > 1)
      problems.push("frontmatter: description is more than one sentence");
  }

  const checkSentences = (node, text) => {
    for (const s of sentencesOf(text)) {
      const n = words(s);
      const excerpt = s.length > 70 ? `${s.slice(0, 70)}…` : s;
      if (n > LIMITS.sentenceWords)
        report(
          node,
          `sentence of ${n} words (limit ${LIMITS.sentenceWords}): "${excerpt}"`,
        );
      const dashes = (s.match(/—|--/g) ?? []).length;
      if (dashes > LIMITS.dashesPerSentence)
        report(
          node,
          `sentence with ${dashes} em-dashes (limit ${LIMITS.dashesPerSentence}): "${excerpt}"`,
        );
      const semis = (s.match(/;/g) ?? []).length;
      if (semis > LIMITS.semicolonsPerSentence)
        report(
          node,
          `sentence with ${semis} semicolons (limit ${LIMITS.semicolonsPerSentence}): "${excerpt}"`,
        );
    }
  };

  let pageWords = 0;
  // The running text under the current heading (any depth). Tables and code
  // do not count toward it.
  let section = {
    title: "(opening, before the first heading)",
    node: null,
    words: 0,
  };
  const closeSection = () => {
    if (section.words > LIMITS.sectionWords)
      problems.push(
        `line ${section.node ? at(section.node) : offset + 1}: ${section.words} words of running text under "${section.title}" (limit ${LIMITS.sectionWords})`,
      );
  };

  // A block is a paragraph, or one list item: the item's own paragraphs, read
  // as one. Everything else inside an item (a nested list, a table, a code
  // block) is walked as content of its own.
  const block = (node, text) => {
    const n = words(text);
    pageWords += n;
    section.words += n;
    if (n > LIMITS.blockWords)
      report(
        node,
        `${node.type === "listItem" ? "list item" : "paragraph"} of ${n} words (limit ${LIMITS.blockWords})`,
      );
    checkSentences(node, text);
  };

  const walk = (node) => {
    if (node.type === "code" || node.type === "html" || node.type === "yaml")
      return;
    switch (node.type) {
      case "heading": {
        closeSection();
        const title = plain(node).trim();
        section = { title, node, words: 0 };
        pageWords += words(title);
        checkSentences(node, title);
        return;
      }
      case "paragraph": {
        if (node.children[0]?.type === "strong")
          report(
            node,
            "paragraph opens with a bold run-in — use a heading, a list or a table",
          );
        block(node, plain(node));
        return;
      }
      case "listItem": {
        const isParagraph = (c) => c.type === "paragraph";
        const text = node.children.filter(isParagraph).map(plain).join(" ");
        block(node, text);
        for (const child of node.children)
          if (!isParagraph(child)) walk(child);
        return;
      }
      case "table": {
        for (const row of node.children)
          for (const cell of row.children) {
            const text = plain(cell);
            const n = words(text);
            pageWords += n;
            if (n > LIMITS.cellWords)
              report(
                cell,
                `table cell of ${n} words (limit ${LIMITS.cellWords})`,
              );
            checkSentences(cell, text);
          }
        return;
      }
      default: {
        for (const child of node.children ?? []) walk(child);
      }
    }
  };

  walk(markdownToMdast(body, { position: true }));
  closeSection();

  if (pageWords > LIMITS.pageWords)
    problems.push(
      `page: ${pageWords} words of running text (limit ${LIMITS.pageWords})`,
    );

  return problems;
}

for (const file of pagesUnder(contentDir)) {
  const slug = file.replace(/\.md$/, "").split("\\").join("/");
  test(slug, () => {
    const page = splitFrontmatter(readFileSync(join(contentDir, file), "utf8"));
    const problems = lintPage(page);
    assert.deepEqual(
      problems,
      [],
      `docs/${file} breaks the writing standard (dev/skills/docs-writing/SKILL.md):\n  ${problems.join("\n  ")}`,
    );
  });
}
