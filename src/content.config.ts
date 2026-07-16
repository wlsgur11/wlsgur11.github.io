import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			titleEn: z.string().optional(),
			description: z.string(),
			descriptionEn: z.string().optional(),
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			tags: z.array(z.string()).default([]),
			project: z.string().optional(),
			draft: z.boolean().default(false),
		}),
});

const projects = defineCollection({
	loader: glob({ base: './src/content/projects', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			titleEn: z.string().optional(),
			description: z.string(),
			descriptionEn: z.string().optional(),
			role: z.string(),
			roleEn: z.string().optional(),
			period: z.string(),
			logo: z.string().optional(),
			cover: z.string().optional(),
			badge: z.string().optional(),
			badgeEn: z.string().optional(),
			summary: z.array(z.string()).default([]),
			summaryEn: z.array(z.string()).default([]),
			stack: z.array(z.string()).default([]),
			links: z
				.object({ repo: z.string().optional(), live: z.string().optional() })
				.default({}),
			featured: z.boolean().default(false),
			group: z.enum(['activity', 'major', 'more']).default('more'),
			order: z.number().default(99),
			heroImage: z.optional(image()),
			draft: z.boolean().default(false),
		}),
});

export const collections = { blog, projects };
