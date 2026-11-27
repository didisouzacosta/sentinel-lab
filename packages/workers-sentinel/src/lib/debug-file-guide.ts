/**
 * How to send debug files (dSYM, ProGuard/R8 mappings) to one Sentinel
 * project, with the server and project filled in. Served by the MCP
 * (`get_debug_file_upload`, the `upload_debug_files` prompt) and mirrored by
 * the README section "Debug files". Dependency-free like lib/platforms.ts.
 *
 * Verified against Sentinel: sentry-cli 3.8.2 (`debug-files upload`,
 * `upload-proguard` with and without `--uuid`, `info`) and the direct API
 * with curl. The Sentry Android Gradle plugin speaks the same sentry-cli
 * protocol but has not been run against Sentinel yet. The curl-only script
 * for Xcode Cloud and archive post-actions lives in the repository
 * (examples/ios/ci_scripts/) and was run against a local server, not yet in
 * Xcode Cloud itself.
 */

/** API token placeholder: guides never carry a real credential. */
export const TOKEN_ENV = 'SENTINEL_AUTH_TOKEN';

/** The org path segment sentry-cli needs; Sentinel accepts any value. */
export const SENTRY_ORG = 'sentinel';

/** The curl-only upload script and its Xcode Cloud hook (README: "Sending dSYMs automatically"). */
export const UPLOAD_SCRIPTS_URL =
	'https://github.com/didisouzacosta/sentinel-lab/tree/main/examples/ios/ci_scripts';
const UPLOAD_SCRIPT_RAW =
	'https://raw.githubusercontent.com/didisouzacosta/sentinel-lab/main/examples/ios/ci_scripts';

export interface DebugFileGuide {
	server: string;
	project: string;
	token: string;
	sentryCli: { env: Record<string, string>; ios: string; android: string; verify: string };
	xcodeBuildPhase: string;
	xcodeCloud: { steps: string[]; environment: Record<string, string>; ciPostXcodebuild: string };
	archivePostAction: string;
	githubActionsIos: string;
	githubActionsAndroid: string;
	gradle: string;
	api: { upload: string; uploadProguard: string; check: string; list: string };
	limits: string[];
}

export function debugFileGuide(origin: string, slug: string): DebugFileGuide {
	const api = `${origin}/api/0/projects/${SENTRY_ORG}/${slug}`;
	const env = {
		SENTRY_URL: origin,
		SENTRY_ORG,
		SENTRY_PROJECT: slug,
		SENTRY_AUTH_TOKEN: `$${TOKEN_ENV}`,
	};
	return {
		server: origin,
		project: slug,
		token: `An API token with the "write" scope (dashboard → Settings → API tokens), stored as a secret named ${TOKEN_ENV}. Never commit it or put it in an app.`,
		sentryCli: {
			env,
			ios: 'sentry-cli debug-files upload --wait path/to/MyApp.xcarchive/dSYMs',
			android:
				'sentry-cli upload-proguard --uuid <the UUID built into the app> app/build/outputs/mapping/release/mapping.txt',
			verify: 'sentry-cli info',
		},
		xcodeBuildPhase: [
			'# Build Phases → New Run Script Phase (after "Embed Frameworks"), Release builds.',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Xcode build-setting syntax, not JS
			'# Input Files: ${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}',
			'# Build Settings: DEBUG_INFORMATION_FORMAT = dwarf-with-dsym, and',
			'# ENABLE_USER_SCRIPT_SANDBOXING = NO (sentry-cli reads the dSYM folder).',
			'# The token comes from ~/.sentryclirc ([auth] token=…) on the build machine.',
			'if [ "$CONFIGURATION" != "Release" ]; then exit 0; fi',
			'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"',
			'if ! command -v sentry-cli >/dev/null; then',
			'  echo "warning: sentry-cli not installed (brew install getsentry/tools/sentry-cli)"',
			'  exit 0',
			'fi',
			`export SENTRY_URL="${origin}" SENTRY_ORG="${SENTRY_ORG}" SENTRY_PROJECT="${slug}"`,
			'sentry-cli debug-files upload "$DWARF_DSYM_FOLDER_PATH" || echo "warning: dSYM upload to Sentinel failed"',
		].join('\n'),
		xcodeCloud: {
			steps: [
				`Download both scripts into a ci_scripts folder next to the .xcodeproj/.xcworkspace: mkdir -p ci_scripts && for f in sentinel-upload-dsyms.sh ci_post_xcodebuild.sh; do curl -fsSL "${UPLOAD_SCRIPT_RAW}/$f" -o "ci_scripts/$f"; done && chmod +x ci_scripts/*.sh (an existing ci_post_xcodebuild.sh keeps its content: add only the call to sentinel-upload-dsyms.sh).`,
				'Commit ci_scripts/. Xcode Cloud runs ci_post_xcodebuild.sh after every action; it uploads only after an Archive action, from $CI_ARCHIVE_PATH/dSYMs, with curl (no Homebrew or sentry-cli).',
				'In the Xcode Cloud workflow (Xcode or App Store Connect → workflow → Environment), add the variables below; mark SENTINEL_AUTH_TOKEN as Secret. The user adds them — never an agent.',
				'The workflow needs an Archive action. A failed upload is a warning and never fails the build, unless SENTINEL_STRICT=1.',
			],
			environment: {
				SENTINEL_URL: origin,
				SENTINEL_PROJECT: slug,
				[TOKEN_ENV]: 'Secret: an API token with the "write" scope',
			},
			ciPostXcodebuild: [
				'#!/bin/sh',
				'set -e',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not JS
				'if [ "${CI_XCODEBUILD_ACTION:-}" != "archive" ] || [ -z "${CI_ARCHIVE_PATH:-}" ]; then',
				'  echo "Sentinel: not an archive build, no dSYMs to upload."',
				'  exit 0',
				'fi',
				'"$(dirname "$0")/sentinel-upload-dsyms.sh" "$CI_ARCHIVE_PATH/dSYMs"',
			].join('\n'),
		},
		archivePostAction: [
			'# Scheme → Edit Scheme → Archive → Post-actions → + New Run Script Action,',
			'# "Provide build settings from" the app target. Uploads every archive made',
			'# on this Mac (Product → Archive, Organizer). Post-actions get no shell',
			'# environment: the token comes from the login Keychain, stored once with',
			'#   security add-generic-password -a "$USER" -s sentinel-auth-token -w',
			`export SENTINEL_URL="${origin}" SENTINEL_PROJECT="${slug}"`,
			`export ${TOKEN_ENV}="$(security find-generic-password -s sentinel-auth-token -w)"`,
			'"$SRCROOT/ci_scripts/sentinel-upload-dsyms.sh" "$ARCHIVE_DSYMS_PATH" > /tmp/sentinel-dsyms.log 2>&1',
		].join('\n'),
		githubActionsIos: [
			'- name: Archive',
			'  run: |',
			'    xcodebuild archive -scheme MyApp -configuration Release \\',
			'      -destination "generic/platform=iOS" -archivePath "$RUNNER_TEMP/MyApp.xcarchive" \\',
			'      DEBUG_INFORMATION_FORMAT=dwarf-with-dsym',
			'- name: Upload dSYMs to Sentinel',
			'  env:',
			`    SENTRY_URL: ${origin}`,
			`    SENTRY_ORG: ${SENTRY_ORG}`,
			`    SENTRY_PROJECT: ${slug}`,
			`    SENTRY_AUTH_TOKEN: \${{ secrets.${TOKEN_ENV} }}`,
			'  run: npx --yes @sentry/cli debug-files upload --wait "$RUNNER_TEMP/MyApp.xcarchive/dSYMs"',
		].join('\n'),
		githubActionsAndroid: [
			'- name: Build release (uploads the R8 mapping)',
			'  env:',
			`    ${TOKEN_ENV}: \${{ secrets.${TOKEN_ENV} }}`,
			'  run: ./gradlew assembleRelease',
		].join('\n'),
		gradle: [
			'// app/build.gradle.kts — Sentry Android Gradle plugin (adds the mapping UUID',
			'// to the APK and uploads mapping.txt with it). Not yet run against Sentinel.',
			'plugins {',
			'  id("io.sentry.android.gradle") version "<latest>"',
			'}',
			'',
			'sentry {',
			`  url.set("${origin}")`,
			`  org.set("${SENTRY_ORG}")`,
			`  projectName.set("${slug}")`,
			`  authToken.set(System.getenv("${TOKEN_ENV}"))`,
			'  includeProguardMapping.set(true)',
			'  autoUploadProguardMapping.set(true)',
			'  includeSourceContext.set(false)',
			'  telemetry.set(false) // otherwise the plugin reports to sentry.io',
			'}',
		].join('\n'),
		api: {
			upload: `gzip -c MyApp.app.dSYM/Contents/Resources/DWARF/MyApp | curl --fail-with-body -X POST "${api}/debug-files/?name=MyApp" -H "Authorization: Bearer $${TOKEN_ENV}" -H "Content-Encoding: gzip" --data-binary @-`,
			uploadProguard: `curl --fail-with-body -X POST "${api}/debug-files/?kind=proguard&debugId=<uuid>" -H "Authorization: Bearer $${TOKEN_ENV}" --data-binary @app/build/outputs/mapping/release/mapping.txt`,
			check: `curl -X POST "${api}/debug-files/check/" -H "Authorization: Bearer $${TOKEN_ENV}" -H "Content-Type: application/json" -d '{"issueId":"<issue id>"}'`,
			list: `curl "${api}/debug-files/" -H "Authorization: Bearer $${TOKEN_ENV}"`,
		},
		limits: [
			'Direct API uploads: up to 95 MB per request (gzip counts compressed). sentry-cli uploads in 8 MB chunks, up to 2 GB per file.',
			'Universal (fat) dSYMs are split per architecture; each architecture is stored under its own UUID.',
			'Executables without DWARF are refused by the API (upload the .dSYM); through sentry-cli the app binary next to its dSYM is acknowledged and skipped.',
			'A ProGuard mapping is matched by the UUID the app reports (debug_meta). Without one, the UUID is derived from the content exactly like sentry-cli does.',
			'Storage per project: 5 GB. Re-uploading a UUID replaces it.',
		],
	};
}
