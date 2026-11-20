import { getCollection, type CollectionEntry } from "astro:content";
import { SECTIONS } from "../content.config";

export type DocsEntry = CollectionEntry<"docs">;

export function slugOf(entry: DocsEntry): string {
  return entry.id === "index" ? "" : entry.id.replace(/\/index$/, "");
}

export const hrefOf = (entry: DocsEntry): string => {
  const slug = slugOf(entry);
  return slug === "" ? "/docs/" : `/docs/${slug}/`;
};

export async function docsBySection() {
  const entries = await getCollection("docs");
  return SECTIONS.map((section) => ({
    section,
    pages: entries
      .filter((e) => e.data.section === section)
      .sort((a, b) => a.data.order - b.data.order),
  }));
}
