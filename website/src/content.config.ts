import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

/** The sidebar's groups, in the order it shows them. */
export const SECTIONS = [
  "Start",
  "Use odu",
  "Run the service",
  "Binary cache",
  "Reference",
] as const;

const docs = defineCollection({
  // A page's id is its path under the base without `.md`: `index`,
  // `cache/index`, `cache/push`. `slugOf` turns it into the URL.
  loader: glob({
    pattern: "**/*.md",
    base: "./src/content/docs",
    generateId: ({ entry }) => entry.replace(/\.md$/, ""),
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.enum(SECTIONS),
    order: z.number(),
  }),
});

export const collections = { docs };
