import { posix as path } from 'path';
import type * as ts from 'typescript/lib/tsserverlibrary';
import { createDocumentRegistry, forEachEmbeddeds } from './documentRegistry';
import { LanguageModule, SourceFile, LanguageServiceHost, EmbeddedFileKind } from './types';
import { shallowReactive as reactive } from '@vue/reactivity';

export type EmbeddedLanguageContext = ReturnType<typeof createEmbeddedLanguageServiceHost>;

export function createEmbeddedLanguageServiceHost(
	host: LanguageServiceHost,
	languageModules: LanguageModule[],
) {

	for (const languageModule of languageModules.reverse()) {
		if (languageModule.proxyLanguageServiceHost) {
			const proxyApis = languageModule.proxyLanguageServiceHost(host);
			host = new Proxy(host, {
				get(target, key: keyof ts.LanguageServiceHost) {
					if (key in proxyApis) {
						return proxyApis[key];
					}
					return target[key];
				},
			});
		}
	}

	let lastProjectVersion: string | undefined;
	let tsProjectVersion = 0;

	const documentRegistry = createDocumentRegistry();
	const ts = host.getTypeScriptModule();
	const scriptSnapshots = new Map<string, [string, ts.IScriptSnapshot]>();
	const sourceTsFileVersions = new Map<string, string>();
	const sourceVueFileVersions = new Map<string, string>();
	const virtualFileVersions = new Map<string, string>();
	const _tsHost: Partial<ts.LanguageServiceHost> = {
		fileExists: host.fileExists
			? fileName => {

				// .vue.js -> .vue
				// .vue.ts -> .vue
				// .vue.d.ts -> [ignored]
				const vueFileName = fileName.substring(0, fileName.lastIndexOf('.'));

				if (!documentRegistry.get(vueFileName)) {
					// create virtual files
					const scriptSnapshot = host.getScriptSnapshot(vueFileName);
					if (scriptSnapshot) {
						for (const languageModule of languageModules) {
							const sourceFile = languageModule.createSourceFile(vueFileName, scriptSnapshot);
							if (sourceFile) {
								documentRegistry.set(vueFileName, reactive(sourceFile), languageModule);
								break;
							}
						}
					}
				}

				if (!!documentRegistry.fromEmbeddedFileName(fileName)) {
					return true;
				}

				return !!host.fileExists?.(fileName);
			}
			: undefined,
		getProjectVersion: () => {
			return tsProjectVersion.toString();
		},
		getScriptFileNames,
		getScriptVersion,
		getScriptSnapshot,
		readDirectory: (_path, extensions, exclude, include, depth) => {
			const result = host.readDirectory?.(_path, extensions, exclude, include, depth) ?? [];
			for (const [sourceFile] of documentRegistry.all()) {
				const vuePath2 = path.join(_path, path.basename(sourceFile.fileName));
				if (path.relative(_path.toLowerCase(), sourceFile.fileName.toLowerCase()).startsWith('..')) {
					continue;
				}
				if (!depth && sourceFile.fileName.toLowerCase() === vuePath2.toLowerCase()) {
					result.push(vuePath2);
				}
				else if (depth) {
					result.push(vuePath2); // TODO: depth num
				}
			}
			return result;
		},
		getScriptKind(fileName) {

			if (documentRegistry.has(fileName))
				return ts.ScriptKind.Deferred;

			switch (path.extname(fileName)) {
				case '.js': return ts.ScriptKind.JS;
				case '.jsx': return ts.ScriptKind.JSX;
				case '.ts': return ts.ScriptKind.TS;
				case '.tsx': return ts.ScriptKind.TSX;
				case '.json': return ts.ScriptKind.JSON;
				default: return ts.ScriptKind.Unknown;
			}
		},
	};

	return {
		typescriptLanguageServiceHost: new Proxy(_tsHost as ts.LanguageServiceHost, {
			get: (target, property: keyof ts.LanguageServiceHost) => {
				update();
				return target[property] || host[property];
			},
		}),
		mapper: new Proxy(documentRegistry, {
			get: (target, property) => {
				update();
				return target[property as keyof typeof documentRegistry];
			},
		}),
	};

	function update() {

		const newProjectVersion = host.getProjectVersion?.();
		const shouldUpdate = newProjectVersion === undefined || newProjectVersion !== lastProjectVersion;

		lastProjectVersion = newProjectVersion;

		if (!shouldUpdate)
			return;

		let tsFileUpdated = false;

		const checkRemains = new Set(host.getScriptFileNames());
		const sourceFilesShouldUpdate: [SourceFile, LanguageModule, ts.IScriptSnapshot][] = [];

		// .vue
		for (const [sourceFile, languageModule] of documentRegistry.all()) {
			checkRemains.delete(sourceFile.fileName);

			const snapshot = host.getScriptSnapshot(sourceFile.fileName);
			if (!snapshot) {
				// delete
				documentRegistry.delete(sourceFile.fileName)
				tsFileUpdated = true;
				continue;
			}

			const newVersion = host.getScriptVersion(sourceFile.fileName);
			if (sourceVueFileVersions.get(sourceFile.fileName) !== newVersion) {
				// update
				sourceVueFileVersions.set(sourceFile.fileName, newVersion);
				sourceFilesShouldUpdate.push([sourceFile, languageModule, snapshot]);
			}
		}

		// no any vue file version change, it mean project version was update by ts file change at this time
		if (!sourceFilesShouldUpdate.length) {
			tsFileUpdated = true;
		}

		// add
		for (const fileName of [...checkRemains]) {
			const snapshot = host.getScriptSnapshot(fileName);
			if (snapshot) {
				for (const languageModule of languageModules) {
					const sourceFile = languageModule.createSourceFile(fileName, snapshot);
					if (sourceFile) {
						sourceVueFileVersions.set(sourceFile.fileName, host.getScriptVersion(fileName));
						documentRegistry.set(fileName, reactive(sourceFile), languageModule);
						checkRemains.delete(fileName);
						break;
					}
				}
			}
		}

		// .ts / .js / .d.ts / .json ...
		for (const [oldTsFileName, oldTsFileVersion] of [...sourceTsFileVersions]) {
			const newVersion = host.getScriptVersion(oldTsFileName);
			if (oldTsFileVersion !== newVersion) {
				if (!checkRemains.has(oldTsFileName) && !host.getScriptSnapshot(oldTsFileName)) {
					// delete
					sourceTsFileVersions.delete(oldTsFileName);
				}
				else {
					// update
					sourceTsFileVersions.set(oldTsFileName, newVersion);
				}
				tsFileUpdated = true;
			}
		}

		for (const nowFileName of checkRemains) {
			if (!sourceTsFileVersions.has(nowFileName)) {
				// add
				const newVersion = host.getScriptVersion(nowFileName);
				sourceTsFileVersions.set(nowFileName, newVersion);
				tsFileUpdated = true;
			}
		}

		for (const [sourceFile, languageModule, snapshot] of sourceFilesShouldUpdate) {

			forEachEmbeddeds(sourceFile, embedded => {
				virtualFileVersions.delete(embedded.fileName);
			});

			const oldScripts: Record<string, string> = {};
			const newScripts: Record<string, string> = {};

			if (!tsFileUpdated) {
				forEachEmbeddeds(sourceFile, embedded => {
					if (embedded.kind) {
						oldScripts[embedded.fileName] = embedded.text;
					}
				});
			}

			languageModule.updateSourceFile(sourceFile, snapshot);
			documentRegistry.onSourceFileUpdated(sourceFile);

			if (!tsFileUpdated) {
				forEachEmbeddeds(sourceFile, embedded => {
					if (embedded.kind) {
						newScripts[embedded.fileName] = embedded.text;
					}
				});
			}

			if (
				!tsFileUpdated
				&& Object.keys(oldScripts).length !== Object.keys(newScripts).length
				|| Object.keys(oldScripts).some(fileName => oldScripts[fileName] !== newScripts[fileName])
			) {
				tsFileUpdated = true;
			}
		}

		if (tsFileUpdated) {
			tsProjectVersion++;
		}
	}
	function getScriptFileNames() {

		const tsFileNames = new Set<string>();

		for (const [sourceFile] of documentRegistry.all()) {
			forEachEmbeddeds(sourceFile, embedded => {
				if (embedded.kind === EmbeddedFileKind.TypeScriptHostFile) {
					tsFileNames.add(embedded.fileName); // virtual .ts
				}
			});
		}

		for (const fileName of host.getScriptFileNames()) {
			if (!documentRegistry.has(fileName)) {
				tsFileNames.add(fileName); // .ts
			}
		}

		return [...tsFileNames];
	}
	function getScriptVersion(fileName: string) {
		let mapped = documentRegistry.fromEmbeddedFileName(fileName);
		if (mapped) {
			if (virtualFileVersions.has(mapped.embedded.fileName)) {
				return virtualFileVersions.get(mapped.embedded.fileName)!;
			}
			else {
				let version = ts.sys?.createHash?.(mapped.embedded.text) ?? mapped.embedded.text;
				if (host.isTsc) {
					// fix https://github.com/johnsoncodehk/volar/issues/1082
					version = host.getScriptVersion(mapped.sourceFile.fileName) + ':' + version;
				}
				virtualFileVersions.set(mapped.embedded.fileName, version);
				return version;
			}
		}
		return host.getScriptVersion(fileName);
	}
	function getScriptSnapshot(fileName: string) {
		const version = getScriptVersion(fileName);
		const cache = scriptSnapshots.get(fileName.toLowerCase());
		if (cache && cache[0] === version) {
			return cache[1];
		}
		const mapped = documentRegistry.fromEmbeddedFileName(fileName);
		if (mapped) {
			const snapshot = ts.ScriptSnapshot.fromString(mapped.embedded.text);
			scriptSnapshots.set(fileName.toLowerCase(), [version, snapshot]);
			return snapshot;
		}
		let tsScript = host.getScriptSnapshot(fileName);
		if (tsScript) {
			scriptSnapshots.set(fileName.toLowerCase(), [version, tsScript]);
			return tsScript;
		}
	}
}
