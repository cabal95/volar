import { Mapping, SourceMapBase } from '@volar/source-map';
import { computed, shallowReactive } from '@vue/reactivity';
import { Teleport } from './sourceMaps';
import type { EmbeddedFile, LanguageModule, PositionCapabilities, SourceFile, TeleportMappingData } from './types';

export function forEachEmbeddeds(file: EmbeddedFile, cb: (embedded: EmbeddedFile) => void) {
	cb(file);
	for (const child of file.embeddeds) {
		forEachEmbeddeds(child, cb);
	}
}

export type DocumentRegistry = ReturnType<typeof createDocumentRegistry>;

export function createDocumentRegistry() {

	const files = shallowReactive<Record<string, [SourceFile, LanguageModule]>>({});
	const all = computed(() => Object.values(files));
	const sourceMapsByFileName = computed(() => {
		const map = new Map<string, { sourceFile: SourceFile, embedded: EmbeddedFile; }>();
		for (const [sourceFile] of all.value) {
			forEachEmbeddeds(sourceFile, embedded => {
				map.set(normalizePath(embedded.fileName), { sourceFile, embedded });
			});
		}
		return map;
	});
	const teleports = computed(() => {
		const map = new Map<string, Teleport>();
		for (const key in files) {
			const [sourceFile] = files[key]!;
			forEachEmbeddeds(sourceFile, embedded => {
				if (embedded.teleportMappings) {
					map.set(normalizePath(embedded.fileName), getTeleport(sourceFile, embedded.teleportMappings));
				}
			});
		}
		return map;
	});
	const _sourceMaps = new WeakMap<SourceFile, WeakMap<Mapping<PositionCapabilities>[], SourceMapBase<PositionCapabilities>>>();
	const _teleports = new WeakMap<SourceFile, WeakMap<Mapping<TeleportMappingData>[], Teleport>>();

	return {
		get: (fileName: string): [SourceFile, LanguageModule] | undefined => files[normalizePath(fileName)],
		delete: (fileName: string) => delete files[normalizePath(fileName)],
		has: (fileName: string) => !!files[normalizePath(fileName)],
		set: (fileName: string, vueFile: SourceFile, languageModule: LanguageModule) => files[normalizePath(fileName)] = [vueFile, languageModule],
		all: () => all.value,
		getTeleport: (fileName: string) => teleports.value.get(normalizePath(fileName)),
		getSourceMap,
		fromEmbeddedFileName: function (fileName: string) {
			return sourceMapsByFileName.value.get(normalizePath(fileName));
		},
		// TODO: remove this
		onSourceFileUpdated(file: SourceFile) {
			_sourceMaps.delete(file);
			_teleports.delete(file);
		},
	};

	function getSourceMap(file: SourceFile, mappings: Mapping<PositionCapabilities>[]) {
		let map1 = _sourceMaps.get(file);
		if (!map1) {
			map1 = new WeakMap();
			_sourceMaps.set(file, map1);
		}
		let map2 = map1.get(mappings);
		if (!map2) {
			map2 = new SourceMapBase(mappings);
			map1.set(mappings, map2);
		}
		return map2;
	}
	function getTeleport(file: SourceFile, mappings: Mapping<TeleportMappingData>[]) {
		let map1 = _teleports.get(file);
		if (!map1) {
			map1 = new WeakMap();
			_teleports.set(file, map1);
		}
		let map2 = map1.get(mappings);
		if (!map2) {
			map2 = new Teleport(mappings);
			map1.set(mappings, map2);
		}
		return map2;
	}
}

function normalizePath(fileName: string) {
	return fileName.replace(/\\/g, '/').toLowerCase();
}
