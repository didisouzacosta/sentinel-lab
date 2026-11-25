import { describe, expect, it } from 'vitest';
import { buildIssueExport, ISSUE_EXPORT_FORMAT, issueExportFilename } from '../lib/issue-export';

const event = {
	event_id: 'evt-2',
	timestamp: '2026-10-11T10:00:00Z',
	environment: 'production',
	release: 'web@1.2.3',
	exception: {
		values: [
			{
				type: 'TypeError',
				value: 'boom',
				stacktrace: { frames: [{ filename: 'a.js', lineno: 1 }] },
			},
		],
	},
	breadcrumbs: [{ category: 'ui.click', message: 'Pay' }],
	contexts: { os: { name: 'iOS' } },
	request: { url: 'https://app.example.com/checkout' },
};

describe('buildIssueExport', () => {
	it('carries the issue, the whole selected event and a readme for the AI', () => {
		const out = buildIssueExport({
			project: { slug: 'web', name: 'Web' },
			issue: { id: 'issue-1', title: 'TypeError', count: 3 },
			event,
			events: [
				event,
				{
					event_id: 'evt-1',
					timestamp: '2026-10-10T10:00:00Z',
					environment: 'staging',
					exception: {},
				},
			],
			activity: [
				{
					type: 'comment',
					userName: 'Ana',
					createdAt: '2026-10-11T11:00:00Z',
					data: { body: 'looking' },
				},
			],
			issueUrl: 'https://sentinel.example.com/projects/web/issues/issue-1',
			exportedAt: new Date('2026-11-25T12:00:00Z'),
		});
		expect(out.format).toBe(ISSUE_EXPORT_FORMAT);
		expect(out.readme).toContain('root cause');
		expect(out.exportedAt).toBe('2026-11-25T12:00:00.000Z');
		expect(out.issue).toEqual({
			id: 'issue-1',
			title: 'TypeError',
			count: 3,
			url: 'https://sentinel.example.com/projects/web/issues/issue-1',
		});
		// the event goes in whole: nothing summarized away
		expect(out.event).toEqual(event);
		// other loaded events: identity only
		expect(out.otherEvents).toEqual([
			{
				event_id: 'evt-1',
				timestamp: '2026-10-10T10:00:00Z',
				environment: 'staging',
				release: undefined,
			},
		]);
		expect(out.activity).toEqual([
			{ type: 'comment', by: 'Ana', at: '2026-10-11T11:00:00Z', data: { body: 'looking' } },
		]);
		expect(out).not.toHaveProperty('sourceMappedFrames');
	});

	it('adds source-mapped frames, innermost first, only the resolved ones', () => {
		const out = buildIssueExport({
			project: { slug: 'web' },
			issue: { id: 'issue-1' },
			event,
			events: [event],
			issueUrl: 'u',
			resolvedFrames: new Map([
				[
					1,
					{
						originalFilename: 'src/b.ts',
						originalFunction: 'b',
						originalLineno: 20,
						originalColno: 3,
						resolved: true,
					},
				],
				[
					0,
					{
						originalFilename: 'src/a.ts',
						originalFunction: 'a',
						originalLineno: 10,
						originalColno: 1,
						resolved: true,
					},
				],
				[
					2,
					{
						originalFilename: null,
						originalFunction: null,
						originalLineno: null,
						originalColno: null,
						resolved: false,
					},
				],
			]),
		});
		expect(out.sourceMappedFrames).toEqual([
			{ frameFromTop: 0, file: 'src/a.ts', function: 'a', line: 10, column: 1 },
			{ frameFromTop: 1, file: 'src/b.ts', function: 'b', line: 20, column: 3 },
		]);
	});

	it('names the file after the project and issue', () => {
		expect(issueExportFilename('web front', '0123456789abcdef')).toBe(
			'sentinel-web-front-01234567.json',
		);
	});
});
