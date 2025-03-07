import boxen from 'boxen';
import { diffWords } from 'diff';
import { execa } from 'execa';
import { bold, cyan, dim, green, magenta, red, yellow } from 'kleur/colors';
import fsMod, { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import maxSatisfying from 'semver/ranges/max-satisfying.js';
import ora from 'ora';
import preferredPM from 'preferred-pm';
import prompts from 'prompts';
import type yargs from 'yargs-parser';
import {
	loadTSConfig,
	resolveConfig,
	resolveConfigPath,
	resolveRoot,
} from '../../core/config/index.js';
import {
	defaultTSConfig,
	presets,
	updateTSConfigForFramework,
	type frameworkWithTSSettings,
} from '../../core/config/tsconfig.js';
import type { Logger } from '../../core/logger/core.js';
import * as msg from '../../core/messages.js';
import { printHelp } from '../../core/messages.js';
import { appendForwardSlash } from '../../core/path.js';
import { apply as applyPolyfill } from '../../core/polyfill.js';
import { ensureProcessNodeEnv, parseNpmName } from '../../core/util.js';
import { eventCliSession, telemetry } from '../../events/index.js';
import { createLoggerFromFlags, flagsToAstroInlineConfig } from '../flags.js';
import { generate, parse, t, visit } from './babel.js';
import { ensureImport } from './imports.js';
import { wrapDefaultExport } from './wrapper.js';

interface AddOptions {
	flags: yargs.Arguments;
}

interface IntegrationInfo {
	id: string;
	packageName: string;
	dependencies: [name: string, version: string][];
	type: 'integration' | 'adapter';
}

const ALIASES = new Map([
	['solid', 'solid-js'],
	['tailwindcss', 'tailwind'],
]);
const ASTRO_CONFIG_STUB = `import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});`;
const TAILWIND_CONFIG_STUB = `/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
	theme: {
		extend: {},
	},
	plugins: [],
}\n`;
const SVELTE_CONFIG_STUB = `\
import { vitePreprocess } from '@astrojs/svelte';

export default {
	preprocess: vitePreprocess(),
};
`;
const LIT_NPMRC_STUB = `\
# Lit libraries are required to be hoisted due to dependency issues.
public-hoist-pattern[]=*lit*
`;

const OFFICIAL_ADAPTER_TO_IMPORT_MAP: Record<string, string> = {
	netlify: '@astrojs/netlify',
	vercel: '@astrojs/vercel/serverless',
	cloudflare: '@astrojs/cloudflare',
	node: '@astrojs/node',
};

// Users might lack access to the global npm registry, this function
// checks the user's project type and will return the proper npm registry
//
// A copy of this function also exists in the create-astro package
async function getRegistry(): Promise<string> {
	const packageManager = (await preferredPM(process.cwd()))?.name || 'npm';
	try {
		const { stdout } = await execa(packageManager, ['config', 'get', 'registry']);
		return stdout?.trim()?.replace(/\/$/, '') || 'https://registry.npmjs.org';
	} catch (e) {
		return 'https://registry.npmjs.org';
	}
}

export async function add(names: string[], { flags }: AddOptions) {
	ensureProcessNodeEnv('production');
	const inlineConfig = flagsToAstroInlineConfig(flags);
	const { userConfig } = await resolveConfig(inlineConfig, 'add');
	telemetry.record(eventCliSession('add', userConfig));
	applyPolyfill();
	if (flags.help || names.length === 0) {
		printHelp({
			commandName: 'astro add',
			usage: '[...integrations] [...adapters]',
			tables: {
				Flags: [
					['--yes', 'Accept all prompts.'],
					['--help', 'Show this help message.'],
				],
				'UI Frameworks': [
					['react', 'astro add react'],
					['preact', 'astro add preact'],
					['vue', 'astro add vue'],
					['svelte', 'astro add svelte'],
					['solid-js', 'astro add solid-js'],
					['lit', 'astro add lit'],
					['alpinejs', 'astro add alpinejs'],
				],
				'Documentation Frameworks': [['starlight', 'astro add starlight']],
				'SSR Adapters': [
					['netlify', 'astro add netlify'],
					['vercel', 'astro add vercel'],
					['deno', 'astro add deno'],
					['cloudflare', 'astro add cloudflare'],
					['node', 'astro add node'],
				],
				Others: [
					['tailwind', 'astro add tailwind'],
					['image', 'astro add image'],
					['mdx', 'astro add mdx'],
					['partytown', 'astro add partytown'],
					['sitemap', 'astro add sitemap'],
					['prefetch', 'astro add prefetch'],
				],
			},
			description: `For more integrations, check out: ${cyan('https://astro.build/integrations')}`,
		});
		return;
	}

	// Some packages might have a common alias! We normalize those here.
	const cwd = flags.root;
	const logger = createLoggerFromFlags(flags);
	const integrationNames = names.map((name) => (ALIASES.has(name) ? ALIASES.get(name)! : name));
	const integrations = await validateIntegrations(integrationNames);
	let installResult = await tryToInstallIntegrations({ integrations, cwd, flags, logger });
	const rootPath = resolveRoot(cwd);
	const root = pathToFileURL(rootPath);
	// Append forward slash to compute relative paths
	root.href = appendForwardSlash(root.href);

	switch (installResult) {
		case UpdateResult.updated: {
			if (integrations.find((integration) => integration.id === 'tailwind')) {
				await setupIntegrationConfig({
					root,
					logger,

					flags,
					integrationName: 'Tailwind',
					possibleConfigFiles: [
						'./tailwind.config.cjs',
						'./tailwind.config.mjs',
						'./tailwind.config.ts',
						'./tailwind.config.mts',
						'./tailwind.config.cts',
						'./tailwind.config.js',
					],
					defaultConfigFile: './tailwind.config.mjs',
					defaultConfigContent: TAILWIND_CONFIG_STUB,
				});
			}
			if (integrations.find((integration) => integration.id === 'svelte')) {
				await setupIntegrationConfig({
					root,
					logger,
					flags,
					integrationName: 'Svelte',
					possibleConfigFiles: ['./svelte.config.js', './svelte.config.cjs', './svelte.config.mjs'],
					defaultConfigFile: './svelte.config.js',
					defaultConfigContent: SVELTE_CONFIG_STUB,
				});
			}
			// Some lit dependencies needs to be hoisted, so for strict package managers like pnpm,
			// we add an .npmrc to hoist them
			if (
				integrations.find((integration) => integration.id === 'lit') &&
				(await preferredPM(fileURLToPath(root)))?.name === 'pnpm'
			) {
				await setupIntegrationConfig({
					root,
					logger,
					flags,
					integrationName: 'Lit',
					possibleConfigFiles: ['./.npmrc'],
					defaultConfigFile: './.npmrc',
					defaultConfigContent: LIT_NPMRC_STUB,
				});
			}
			break;
		}
		case UpdateResult.cancelled: {
			logger.info(
				null,
				msg.cancelled(
					`Dependencies ${bold('NOT')} installed.`,
					`Be sure to install them manually before continuing!`
				)
			);
			break;
		}
		case UpdateResult.failure: {
			throw createPrettyError(new Error(`Unable to install dependencies`));
		}
		case UpdateResult.none:
			break;
	}

	const rawConfigPath = await resolveConfigPath({
		root: rootPath,
		configFile: flags.config,
		fs: fsMod,
	});
	let configURL = rawConfigPath ? pathToFileURL(rawConfigPath) : undefined;

	if (configURL) {
		logger.debug('add', `Found config at ${configURL}`);
	} else {
		logger.info('add', `Unable to locate a config file, generating one for you.`);
		configURL = new URL('./astro.config.mjs', root);
		await fs.writeFile(fileURLToPath(configURL), ASTRO_CONFIG_STUB, { encoding: 'utf-8' });
	}

	let ast: t.File | null = null;
	try {
		ast = await parseAstroConfig(configURL);

		logger.debug('add', 'Parsed astro config');

		const defineConfig = t.identifier('defineConfig');
		ensureImport(
			ast,
			t.importDeclaration(
				[t.importSpecifier(defineConfig, defineConfig)],
				t.stringLiteral('astro/config')
			)
		);
		wrapDefaultExport(ast, defineConfig);

		logger.debug('add', 'Astro config ensured `defineConfig`');

		for (const integration of integrations) {
			if (isAdapter(integration)) {
				const officialExportName = OFFICIAL_ADAPTER_TO_IMPORT_MAP[integration.id];
				if (officialExportName) {
					await setAdapter(ast, integration, officialExportName);
				} else {
					logger.info(
						null,
						`\n  ${magenta(
							`Check our deployment docs for ${bold(
								integration.packageName
							)} to update your "adapter" config.`
						)}`
					);
				}
			} else {
				await addIntegration(ast, integration);
			}
			logger.debug('add', `Astro config added integration ${integration.id}`);
		}
	} catch (err) {
		logger.debug('add', 'Error parsing/modifying astro config: ', err);
		throw createPrettyError(err as Error);
	}

	let configResult: UpdateResult | undefined;

	if (ast) {
		try {
			configResult = await updateAstroConfig({
				configURL,
				ast,
				flags,
				logger,
				logAdapterInstructions: integrations.some(isAdapter),
			});
		} catch (err) {
			logger.debug('add', 'Error updating astro config', err);
			throw createPrettyError(err as Error);
		}
	}

	switch (configResult) {
		case UpdateResult.cancelled: {
			logger.info(null, msg.cancelled(`Your configuration has ${bold('NOT')} been updated.`));
			break;
		}
		case UpdateResult.none: {
			const pkgURL = new URL('./package.json', configURL);
			if (existsSync(fileURLToPath(pkgURL))) {
				const { dependencies = {}, devDependencies = {} } = await fs
					.readFile(fileURLToPath(pkgURL))
					.then((res) => JSON.parse(res.toString()));
				const deps = Object.keys(Object.assign(dependencies, devDependencies));
				const missingDeps = integrations.filter(
					(integration) => !deps.includes(integration.packageName)
				);
				if (missingDeps.length === 0) {
					logger.info(null, msg.success(`Configuration up-to-date.`));
					break;
				}
			}

			logger.info(null, msg.success(`Configuration up-to-date.`));
			break;
		}
		default: {
			const list = integrations.map((integration) => `  - ${integration.packageName}`).join('\n');
			logger.info(
				null,
				msg.success(
					`Added the following integration${
						integrations.length === 1 ? '' : 's'
					} to your project:\n${list}`
				)
			);
		}
	}

	const updateTSConfigResult = await updateTSConfig(cwd, logger, integrations, flags);

	switch (updateTSConfigResult) {
		case UpdateResult.none: {
			break;
		}
		case UpdateResult.cancelled: {
			logger.info(
				null,
				msg.cancelled(`Your TypeScript configuration has ${bold('NOT')} been updated.`)
			);
			break;
		}
		case UpdateResult.failure: {
			throw new Error(
				`Unknown error parsing tsconfig.json or jsconfig.json. Could not update TypeScript settings.`
			);
		}
		default:
			logger.info(null, msg.success(`Successfully updated TypeScript settings`));
	}
}

function isAdapter(
	integration: IntegrationInfo
): integration is IntegrationInfo & { type: 'adapter' } {
	return integration.type === 'adapter';
}

async function parseAstroConfig(configURL: URL): Promise<t.File> {
	const source = await fs.readFile(fileURLToPath(configURL), { encoding: 'utf-8' });
	const result = parse(source);

	if (!result) throw new Error('Unknown error parsing astro config');
	if (result.errors.length > 0)
		throw new Error('Error parsing astro config: ' + JSON.stringify(result.errors));

	return result;
}

// Convert an arbitrary NPM package name into a JS identifier
// Some examples:
//  - @astrojs/image => image
//  - @astrojs/markdown-component => markdownComponent
//  - astro-cast => cast
//  - markdown-astro => markdown
//  - some-package => somePackage
//  - example.com => exampleCom
//  - under_score => underScore
//  - 123numeric => numeric
//  - @npm/thingy => npmThingy
//  - @jane/foo.js => janeFoo
//  - @tokencss/astro => tokencss
const toIdent = (name: string) => {
	const ident = name
		.trim()
		// Remove astro or (astrojs) prefix and suffix
		.replace(/[-_\.\/]?astro(?:js)?[-_\.]?/g, '')
		// drop .js suffix
		.replace(/\.js/, '')
		// convert to camel case
		.replace(/(?:[\.\-\_\/]+)([a-zA-Z])/g, (_, w) => w.toUpperCase())
		// drop invalid first characters
		.replace(/^[^a-zA-Z$_]+/, '');
	return `${ident[0].toLowerCase()}${ident.slice(1)}`;
};

function createPrettyError(err: Error) {
	err.message = `Astro could not update your astro.config.js file safely.
Reason: ${err.message}

You will need to add these integration(s) manually.
Documentation: https://docs.astro.build/en/guides/integrations-guide/`;
	return err;
}

async function addIntegration(ast: t.File, integration: IntegrationInfo) {
	const integrationId = t.identifier(toIdent(integration.id));

	ensureImport(
		ast,
		t.importDeclaration(
			[t.importDefaultSpecifier(integrationId)],
			t.stringLiteral(integration.packageName)
		)
	);

	visit(ast, {
		// eslint-disable-next-line @typescript-eslint/no-shadow
		ExportDefaultDeclaration(path) {
			if (!t.isCallExpression(path.node.declaration)) return;

			const configObject = path.node.declaration.arguments[0];
			if (!t.isObjectExpression(configObject)) return;

			let integrationsProp = configObject.properties.find((prop) => {
				if (prop.type !== 'ObjectProperty') return false;
				if (prop.key.type === 'Identifier') {
					if (prop.key.name === 'integrations') return true;
				}
				if (prop.key.type === 'StringLiteral') {
					if (prop.key.value === 'integrations') return true;
				}
				return false;
			}) as t.ObjectProperty | undefined;

			const integrationCall = t.callExpression(integrationId, []);

			if (!integrationsProp) {
				configObject.properties.push(
					t.objectProperty(t.identifier('integrations'), t.arrayExpression([integrationCall]))
				);
				return;
			}

			if (integrationsProp.value.type !== 'ArrayExpression')
				throw new Error('Unable to parse integrations');

			const existingIntegrationCall = integrationsProp.value.elements.find(
				(expr) =>
					t.isCallExpression(expr) &&
					t.isIdentifier(expr.callee) &&
					expr.callee.name === integrationId.name
			);

			if (existingIntegrationCall) return;

			integrationsProp.value.elements.push(integrationCall);
		},
	});
}

async function setAdapter(ast: t.File, adapter: IntegrationInfo, exportName: string) {
	const adapterId = t.identifier(toIdent(adapter.id));

	ensureImport(
		ast,
		t.importDeclaration([t.importDefaultSpecifier(adapterId)], t.stringLiteral(exportName))
	);

	visit(ast, {
		// eslint-disable-next-line @typescript-eslint/no-shadow
		ExportDefaultDeclaration(path) {
			if (!t.isCallExpression(path.node.declaration)) return;

			const configObject = path.node.declaration.arguments[0];
			if (!t.isObjectExpression(configObject)) return;

			let outputProp = configObject.properties.find((prop) => {
				if (prop.type !== 'ObjectProperty') return false;
				if (prop.key.type === 'Identifier') {
					if (prop.key.name === 'output') return true;
				}
				if (prop.key.type === 'StringLiteral') {
					if (prop.key.value === 'output') return true;
				}
				return false;
			}) as t.ObjectProperty | undefined;

			if (!outputProp) {
				configObject.properties.push(
					t.objectProperty(t.identifier('output'), t.stringLiteral('server'))
				);
			}

			let adapterProp = configObject.properties.find((prop) => {
				if (prop.type !== 'ObjectProperty') return false;
				if (prop.key.type === 'Identifier') {
					if (prop.key.name === 'adapter') return true;
				}
				if (prop.key.type === 'StringLiteral') {
					if (prop.key.value === 'adapter') return true;
				}
				return false;
			}) as t.ObjectProperty | undefined;

			let adapterCall;
			switch (adapter.id) {
				// the node adapter requires a mode
				case 'node': {
					adapterCall = t.callExpression(adapterId, [
						t.objectExpression([
							t.objectProperty(t.identifier('mode'), t.stringLiteral('standalone')),
						]),
					]);
					break;
				}
				default: {
					adapterCall = t.callExpression(adapterId, []);
				}
			}

			if (!adapterProp) {
				configObject.properties.push(t.objectProperty(t.identifier('adapter'), adapterCall));
				return;
			}

			adapterProp.value = adapterCall;
		},
	});
}

const enum UpdateResult {
	none,
	updated,
	cancelled,
	failure,
}

async function updateAstroConfig({
	configURL,
	ast,
	flags,
	logger,
	logAdapterInstructions,
}: {
	configURL: URL;
	ast: t.File;
	flags: yargs.Arguments;
	logger: Logger;
	logAdapterInstructions: boolean;
}): Promise<UpdateResult> {
	const input = await fs.readFile(fileURLToPath(configURL), { encoding: 'utf-8' });
	let output = await generate(ast);
	const comment = '// https://astro.build/config';
	const defaultExport = 'export default defineConfig';
	output = output.replace(`\n${comment}`, '');
	output = output.replace(`${defaultExport}`, `\n${comment}\n${defaultExport}`);

	if (input === output) {
		return UpdateResult.none;
	}

	const diff = getDiffContent(input, output);

	if (!diff) {
		return UpdateResult.none;
	}

	const message = `\n${boxen(diff, {
		margin: 0.5,
		padding: 0.5,
		borderStyle: 'round',
		title: configURL.pathname.split('/').pop(),
	})}\n`;

	logger.info(
		null,
		`\n  ${magenta('Astro will make the following changes to your config file:')}\n${message}`
	);

	if (logAdapterInstructions) {
		logger.info(
			null,
			magenta(
				`  For complete deployment options, visit\n  ${bold(
					'https://docs.astro.build/en/guides/deploy/'
				)}\n`
			)
		);
	}

	if (await askToContinue({ flags })) {
		await fs.writeFile(fileURLToPath(configURL), output, { encoding: 'utf-8' });
		logger.debug('add', `Updated astro config`);
		return UpdateResult.updated;
	} else {
		return UpdateResult.cancelled;
	}
}

interface InstallCommand {
	pm: string;
	command: string;
	flags: string[];
	dependencies: string[];
}

async function getInstallIntegrationsCommand({
	integrations,
	logger,
	cwd = process.cwd(),
}: {
	integrations: IntegrationInfo[];
	logger: Logger;
	cwd?: string;
}): Promise<InstallCommand | null> {
	const pm = await preferredPM(cwd);
	logger.debug('add', `package manager: ${JSON.stringify(pm)}`);
	if (!pm) return null;

	const dependencies = await convertIntegrationsToInstallSpecifiers(integrations);
	switch (pm.name) {
		case 'npm':
			return { pm: 'npm', command: 'install', flags: [], dependencies };
		case 'yarn':
			return { pm: 'yarn', command: 'add', flags: [], dependencies };
		case 'pnpm':
			return { pm: 'pnpm', command: 'add', flags: [], dependencies };
		case 'bun':
			return { pm: 'bun', command: 'add', flags: [], dependencies };
		default:
			return null;
	}
}

async function convertIntegrationsToInstallSpecifiers(
	integrations: IntegrationInfo[]
): Promise<string[]> {
	const ranges: Record<string, string> = {};
	for (let { packageName, dependencies } of integrations) {
		ranges[packageName] = '*';
		for (const [name, range] of dependencies) {
			ranges[name] = range;
		}
	}
	return Promise.all(
		Object.entries(ranges).map(([name, range]) => resolveRangeToInstallSpecifier(name, range))
	);
}

/**
 * Resolves package with a given range to a STABLE version
 * peerDependencies might specify a compatible prerelease,
 * but `astro add` should only ever install stable releases
 */
async function resolveRangeToInstallSpecifier(name: string, range: string): Promise<string> {
	const versions = await fetchPackageVersions(name);
	if (versions instanceof Error) return name;
	// Filter out any prerelease versions
	const stableVersions = versions.filter((v) => !v.includes('-'));
	const maxStable = maxSatisfying(stableVersions, range);
	return `${name}@^${maxStable}`;
}

// Allow forwarding of standard `npm install` flags
// See https://docs.npmjs.com/cli/v8/commands/npm-install#description
const INHERITED_FLAGS = new Set<string>([
	'P',
	'save-prod',
	'D',
	'save-dev',
	'E',
	'save-exact',
	'no-save',
]);

async function tryToInstallIntegrations({
	integrations,
	cwd,
	flags,
	logger,
}: {
	integrations: IntegrationInfo[];
	cwd?: string;
	flags: yargs.Arguments;
	logger: Logger;
}): Promise<UpdateResult> {
	const installCommand = await getInstallIntegrationsCommand({ integrations, cwd, logger });

	const inheritedFlags = Object.entries(flags)
		.map(([flag]) => {
			if (flag == '_') return;
			if (INHERITED_FLAGS.has(flag)) {
				if (flag.length === 1) return `-${flag}`;
				return `--${flag}`;
			}
		})
		.filter(Boolean)
		.flat() as string[];

	if (installCommand === null) {
		return UpdateResult.none;
	} else {
		const coloredOutput = `${bold(installCommand.pm)} ${installCommand.command}${[
			'',
			...installCommand.flags,
			...inheritedFlags,
		].join(' ')} ${cyan(installCommand.dependencies.join(' '))}`;
		const message = `\n${boxen(coloredOutput, {
			margin: 0.5,
			padding: 0.5,
			borderStyle: 'round',
		})}\n`;
		logger.info(
			null,
			`\n  ${magenta('Astro will run the following command:')}\n  ${dim(
				'If you skip this step, you can always run it yourself later'
			)}\n${message}`
		);

		if (await askToContinue({ flags })) {
			const spinner = ora('Installing dependencies...').start();
			try {
				await execa(
					installCommand.pm,
					[
						installCommand.command,
						...installCommand.flags,
						...inheritedFlags,
						...installCommand.dependencies,
					],
					{
						cwd,
						// reset NODE_ENV to ensure install command run in dev mode
						env: { NODE_ENV: undefined },
					}
				);
				spinner.succeed();
				return UpdateResult.updated;
			} catch (err: any) {
				spinner.fail();
				logger.debug('add', 'Error installing dependencies', err);
				// NOTE: `err.stdout` can be an empty string, so log the full error instead for a more helpful log
				// eslint-disable-next-line no-console
				console.error('\n', err.stdout || err.message, '\n');
				return UpdateResult.failure;
			}
		} else {
			return UpdateResult.cancelled;
		}
	}
}

async function fetchPackageJson(
	scope: string | undefined,
	name: string,
	tag: string
): Promise<Record<string, any> | Error> {
	const packageName = `${scope ? `${scope}/` : ''}${name}`;
	const registry = await getRegistry();
	const res = await fetch(`${registry}/${packageName}/${tag}`);
	if (res.status >= 200 && res.status < 300) {
		return await res.json();
	} else if (res.status === 404) {
		// 404 means the package doesn't exist, so we don't need an error message here
		return new Error();
	} else {
		return new Error(`Failed to fetch ${registry}/${packageName}/${tag} - GET ${res.status}`);
	}
}

async function fetchPackageVersions(packageName: string): Promise<string[] | Error> {
	const registry = await getRegistry();
	const res = await fetch(`${registry}/${packageName}`, {
		headers: { accept: 'application/vnd.npm.install-v1+json' },
	});
	if (res.status >= 200 && res.status < 300) {
		return await res.json().then((data) => Object.keys(data.versions));
	} else if (res.status === 404) {
		// 404 means the package doesn't exist, so we don't need an error message here
		return new Error();
	} else {
		return new Error(`Failed to fetch ${registry}/${packageName} - GET ${res.status}`);
	}
}

export async function validateIntegrations(integrations: string[]): Promise<IntegrationInfo[]> {
	const spinner = ora('Resolving packages...').start();
	try {
		const integrationEntries = await Promise.all(
			integrations.map(async (integration): Promise<IntegrationInfo> => {
				const parsed = parseIntegrationName(integration);
				if (!parsed) {
					throw new Error(`${bold(integration)} does not appear to be a valid package name!`);
				}
				let { scope, name, tag } = parsed;
				let pkgJson;
				let pkgType: 'first-party' | 'third-party';

				if (scope && scope !== '@astrojs') {
					pkgType = 'third-party';
				} else {
					const firstPartyPkgCheck = await fetchPackageJson('@astrojs', name, tag);
					if (firstPartyPkgCheck instanceof Error) {
						if (firstPartyPkgCheck.message) {
							spinner.warn(yellow(firstPartyPkgCheck.message));
						}
						spinner.warn(
							yellow(`${bold(integration)} is not an official Astro package. Use at your own risk!`)
						);
						const response = await prompts({
							type: 'confirm',
							name: 'askToContinue',
							message: 'Continue?',
							initial: true,
						});
						if (!response.askToContinue) {
							throw new Error(
								`No problem! Find our official integrations at ${cyan(
									'https://astro.build/integrations'
								)}`
							);
						}
						spinner.start('Resolving with third party packages...');
						pkgType = 'third-party';
					} else {
						pkgType = 'first-party';
						pkgJson = firstPartyPkgCheck as any;
					}
				}
				if (pkgType === 'third-party') {
					const thirdPartyPkgCheck = await fetchPackageJson(scope, name, tag);
					if (thirdPartyPkgCheck instanceof Error) {
						if (thirdPartyPkgCheck.message) {
							spinner.warn(yellow(thirdPartyPkgCheck.message));
						}
						throw new Error(`Unable to fetch ${bold(integration)}. Does the package exist?`);
					} else {
						pkgJson = thirdPartyPkgCheck as any;
					}
				}

				const resolvedScope = pkgType === 'first-party' ? '@astrojs' : scope;
				const packageName = `${resolvedScope ? `${resolvedScope}/` : ''}${name}`;

				let dependencies: IntegrationInfo['dependencies'] = [
					[pkgJson['name'], `^${pkgJson['version']}`],
				];

				if (pkgJson['peerDependencies']) {
					const meta = pkgJson['peerDependenciesMeta'] || {};
					for (const peer in pkgJson['peerDependencies']) {
						const optional = meta[peer]?.optional || false;
						const isAstro = peer === 'astro';
						if (!optional && !isAstro) {
							dependencies.push([peer, pkgJson['peerDependencies'][peer]]);
						}
					}
				}

				let integrationType: IntegrationInfo['type'];
				const keywords = Array.isArray(pkgJson['keywords']) ? pkgJson['keywords'] : [];
				if (keywords.includes('astro-integration')) {
					integrationType = 'integration';
				} else if (keywords.includes('astro-adapter')) {
					integrationType = 'adapter';
				} else {
					throw new Error(
						`${bold(
							packageName
						)} doesn't appear to be an integration or an adapter. Find our official integrations at ${cyan(
							'https://astro.build/integrations'
						)}`
					);
				}

				return { id: integration, packageName, dependencies, type: integrationType };
			})
		);
		spinner.succeed();
		return integrationEntries;
	} catch (e) {
		if (e instanceof Error) {
			spinner.fail(e.message);
			process.exit(1);
		} else {
			throw e;
		}
	}
}

async function updateTSConfig(
	cwd = process.cwd(),
	logger: Logger,
	integrationsInfo: IntegrationInfo[],
	flags: yargs.Arguments
): Promise<UpdateResult> {
	const integrations = integrationsInfo.map(
		(integration) => integration.id as frameworkWithTSSettings
	);
	const firstIntegrationWithTSSettings = integrations.find((integration) =>
		presets.has(integration)
	);

	if (!firstIntegrationWithTSSettings) {
		return UpdateResult.none;
	}

	let inputConfig = await loadTSConfig(cwd);
	let inputConfigText = '';

	if (inputConfig === 'invalid-config' || inputConfig === 'unknown-error') {
		return UpdateResult.failure;
	} else if (inputConfig === 'missing-config') {
		logger.debug('add', "Couldn't find tsconfig.json or jsconfig.json, generating one");
		inputConfig = {
			tsconfig: defaultTSConfig,
			tsconfigFile: path.join(cwd, 'tsconfig.json'),
			rawConfig: { tsconfig: defaultTSConfig, tsconfigFile: path.join(cwd, 'tsconfig.json') },
		};
	} else {
		inputConfigText = JSON.stringify(inputConfig.rawConfig.tsconfig, null, 2);
	}

	const configFileName = path.basename(inputConfig.tsconfigFile);

	const outputConfig = updateTSConfigForFramework(
		inputConfig.rawConfig.tsconfig,
		firstIntegrationWithTSSettings
	);

	const output = JSON.stringify(outputConfig, null, 2);
	const diff = getDiffContent(inputConfigText, output);

	if (!diff) {
		return UpdateResult.none;
	}

	const message = `\n${boxen(diff, {
		margin: 0.5,
		padding: 0.5,
		borderStyle: 'round',
		title: configFileName,
	})}\n`;

	logger.info(
		null,
		`\n  ${magenta(`Astro will make the following changes to your ${configFileName}:`)}\n${message}`
	);

	// Every major framework, apart from Vue and Svelte requires different `jsxImportSource`, as such it's impossible to config
	// all of them in the same `tsconfig.json`. However, Vue only need `"jsx": "preserve"` for template intellisense which
	// can be compatible with some frameworks (ex: Solid)
	const conflictingIntegrations = [...Object.keys(presets).filter((config) => config !== 'vue')];
	const hasConflictingIntegrations =
		integrations.filter((integration) => presets.has(integration)).length > 1 &&
		integrations.filter((integration) => conflictingIntegrations.includes(integration)).length > 0;

	if (hasConflictingIntegrations) {
		logger.info(
			null,
			red(
				`  ${bold(
					'Caution:'
				)} Selected UI frameworks require conflicting tsconfig.json settings, as such only settings for ${bold(
					firstIntegrationWithTSSettings
				)} were used.\n  More information: https://docs.astro.build/en/guides/typescript/#errors-typing-multiple-jsx-frameworks-at-the-same-time\n`
			)
		);
	}

	if (await askToContinue({ flags })) {
		await fs.writeFile(inputConfig.tsconfigFile, output, {
			encoding: 'utf-8',
		});
		logger.debug('add', `Updated ${configFileName} file`);
		return UpdateResult.updated;
	} else {
		return UpdateResult.cancelled;
	}
}

function parseIntegrationName(spec: string) {
	const result = parseNpmName(spec);
	if (!result) return;
	let { scope, name } = result;
	let tag = 'latest';
	if (scope) {
		name = name.replace(scope + '/', '');
	}
	if (name.includes('@')) {
		const tagged = name.split('@');
		name = tagged[0];
		tag = tagged[1];
	}
	return { scope, name, tag };
}

async function askToContinue({ flags }: { flags: yargs.Arguments }): Promise<boolean> {
	if (flags.yes || flags.y) return true;

	const response = await prompts({
		type: 'confirm',
		name: 'askToContinue',
		message: 'Continue?',
		initial: true,
	});

	return Boolean(response.askToContinue);
}

function getDiffContent(input: string, output: string): string | null {
	let changes = [];
	for (const change of diffWords(input, output)) {
		let lines = change.value.trim().split('\n').slice(0, change.count);
		if (lines.length === 0) continue;
		if (change.added) {
			if (!change.value.trim()) continue;
			changes.push(change.value);
		}
	}
	if (changes.length === 0) {
		return null;
	}

	let diffed = output;
	for (let newContent of changes) {
		const coloredOutput = newContent
			.split('\n')
			.map((ln) => (ln ? green(ln) : ''))
			.join('\n');
		diffed = diffed.replace(newContent, coloredOutput);
	}

	return diffed;
}

async function setupIntegrationConfig(opts: {
	root: URL;
	logger: Logger;
	flags: yargs.Arguments;
	integrationName: string;
	possibleConfigFiles: string[];
	defaultConfigFile: string;
	defaultConfigContent: string;
}) {
	const logger = opts.logger;
	const possibleConfigFiles = opts.possibleConfigFiles.map((p) =>
		fileURLToPath(new URL(p, opts.root))
	);
	let alreadyConfigured = false;
	for (const possibleConfigPath of possibleConfigFiles) {
		if (existsSync(possibleConfigPath)) {
			alreadyConfigured = true;
			break;
		}
	}
	if (!alreadyConfigured) {
		logger.info(
			null,
			`\n  ${magenta(`Astro will generate a minimal ${bold(opts.defaultConfigFile)} file.`)}\n`
		);
		if (await askToContinue({ flags: opts.flags })) {
			await fs.writeFile(
				fileURLToPath(new URL(opts.defaultConfigFile, opts.root)),
				opts.defaultConfigContent,
				{
					encoding: 'utf-8',
				}
			);
			logger.debug('add', `Generated default ${opts.defaultConfigFile} file`);
		}
	} else {
		logger.debug('add', `Using existing ${opts.integrationName} configuration`);
	}
}
