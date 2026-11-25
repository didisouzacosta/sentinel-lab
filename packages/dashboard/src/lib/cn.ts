import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge our custom text-* sizes so `text-body-s` and
// `text-fg-muted` are not treated as the same conflicting group.
const twMerge = extendTailwindMerge({
	extend: {
		classGroups: {
			'font-size': [
				{
					text: [
						'overline',
						'caption',
						'body-s',
						'body',
						'heading-s',
						'heading-m',
						'heading-l',
						'display',
						'metric',
					],
				},
			],
		},
	},
});

/** Merge class lists, letting later Tailwind utilities win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
