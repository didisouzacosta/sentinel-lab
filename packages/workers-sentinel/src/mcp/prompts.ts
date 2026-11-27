/** MCP prompts: ready-made workflows the client can offer as commands. */

interface PromptArgument {
	name: string;
	description: string;
	required: boolean;
}

interface Prompt {
	definition: { name: string; title: string; description: string; arguments: PromptArgument[] };
	render(args: Record<string, string>): string;
}

export const PROMPTS: Prompt[] = [
	{
		definition: {
			name: 'connect_project',
			title: 'Connect this app to Sentinel',
			description:
				'Walks the agent through connecting the app in the current workspace: pick or create the project, apply the setup guide, verify with a test event.',
			arguments: [
				{
					name: 'project_name',
					description: 'Name for a new project (or an existing slug).',
					required: false,
				},
				{
					name: 'platform',
					description: 'Platform id, if you already know it (see list_platforms).',
					required: false,
				},
			],
		},
		render: ({ project_name, platform }) =>
			[
				'Connect the app in this workspace to Sentinel so its errors are reported there.',
				'',
				'1. Call whoami to see what this token allows (creating projects needs the "projects" scope).',
				"2. Work out the app's platform from the code (package.json, wrangler config, deno.json, Package.swift, build.gradle…)" +
					(platform ? ` — the user said: ${platform}.` : '.') +
					' Match it to an id from list_platforms. A Deno or Hono codebase deployed to Cloudflare runs on Workers. Prefer the "envelope" (no SDK) guide if the app already reports errors through its own small reporter.',
				`3. Look for an existing project with list_projects${project_name ? ` (the user mentioned "${project_name}")` : ''}. If none fits and whoami allows it, ask the user, then create_project.`,
				'4. Call get_setup_guide and apply its steps to the code. Put the DSN where the app keeps configuration (an env var or secret on servers; it is public, so a browser bundle may embed it). Keep personal data out of events.',
				'5. Ask before running anything that deploys or changes secrets. Then call send_test_event and, if possible, trigger a real error and find it with list_issues.',
				'6. Summarize what changed in the code, where the DSN lives and the project dashboard link.',
				'',
				'Ask the user before every tool call that changes something in Sentinel.',
			].join('\n'),
	},
	{
		definition: {
			name: 'triage_issues',
			title: 'Triage Sentinel issues',
			description:
				'Reviews the unresolved issues of a project and proposes fixes for the worst ones.',
			arguments: [{ name: 'project', description: 'Project slug.', required: true }],
		},
		render: ({ project }) =>
			[
				`Triage the unresolved issues of the Sentinel project "${project}".`,
				'',
				'1. list_issues (unresolved, sort by count) and pick the issues that hurt most (count, users, recency).',
				'2. For each, get_issue: read the exception and the [app] frames, find the code in this workspace and explain the cause.',
				'3. Propose a fix (or make it, if the user asks). Only after the user agrees: update_issue to resolve, and add_issue_note with what was done.',
			].join('\n'),
	},
	{
		definition: {
			name: 'upload_debug_files',
			title: 'Upload dSYMs / ProGuard mappings to Sentinel',
			description:
				'Finds the debug files of the app in this workspace (iOS dSYMs, Android R8 mapping), uploads them to a Sentinel project and confirms, optionally setting up automatic uploads (Xcode Cloud, archive post-action, Xcode build phase, GitHub Actions, Gradle).',
			arguments: [
				{ name: 'project', description: 'Project slug.', required: true },
				{
					name: 'issue_id',
					description: 'A crash whose frames are unreadable: upload what it needs.',
					required: false,
				},
			],
		},
		render: ({ project, issue_id }) =>
			[
				`Send this app's debug files to the Sentinel project "${project}" so its native crashes get symbolicated.`,
				'',
				`1. Call get_debug_file_upload for "${project}": it has the server, the sentry-cli environment, Xcode Cloud ci_scripts, an archive post-action, an Xcode build phase, GitHub Actions steps and the Gradle config, ready to paste.`,
				issue_id
					? `2. Call check_debug_files with issueId "${issue_id}" to list the debug ids the crash needs and which are missing.`
					: '2. If the user mentions a crash, call check_debug_files with its issueId to see which debug ids are missing.',
				"3. iOS: find the dSYMs (an .xcarchive's dSYMs folder, or DerivedData/…/Build/Products/Release-iphoneos/*.dSYM; `dwarfdump --uuid` prints their UUIDs). Android: app/build/outputs/mapping/<variant>/mapping.txt, plus the UUID the app embeds (sentry-debug-meta.properties) if any.",
				'4. Upload with sentry-cli when it is installed (it handles folders and big files); otherwise use the curl command, or upload_debug_file for a single small file. The token must come from the environment ($SENTINEL_AUTH_TOKEN) or ~/.sentryclirc; never write it into the repository.',
				'5. Confirm with check_debug_files (status "found").',
				'6. If the user wants it automatic, wire it where the app is built: Xcode Cloud (ci_scripts/ next to the project, or the user says so) → xcodeCloud; archives made on this Mac → archivePostAction; GitHub Actions → githubActionsIos; Android → gradle. Tell them which secret to create themselves (SENTINEL_AUTH_TOKEN, an API token with the "write" scope) and where.',
				'',
				'Ask the user before changing build settings, CI workflows or secrets.',
			].join('\n'),
	},
];

export function renderPrompt(name: unknown, rawArgs: unknown) {
	const prompt = PROMPTS.find((p) => p.definition.name === name);
	if (!prompt) return null;
	const args: Record<string, string> = {};
	if (rawArgs && typeof rawArgs === 'object') {
		for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
			if (typeof value === 'string' && value.length <= 500) args[key] = value;
		}
	}
	return {
		description: prompt.definition.description,
		messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }],
	};
}
