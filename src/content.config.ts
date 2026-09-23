import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * Knowledge base collection.
 *
 * `knowledge/*.md` is the single source of truth of the portfolio and of the AI
 * assistant. The entry id is the file path relative to `knowledge/` without the
 * extension (for example `index`, `about`, `projects/gaplogic`), while
 * `data.id` is the stable document id used by the knowledge tool allowlist.
 */
const knowledge = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./knowledge" }),
  schema: z.object({
    id: z.string(),
    kind: z.enum([
      "index",
      "about",
      "skills",
      "services",
      "experience",
      "contact",
      "project",
    ]),
    title: z.string(),
    description: z.string(),
    url: z.string().optional(),
  }),
});

export const collections = { knowledge };
