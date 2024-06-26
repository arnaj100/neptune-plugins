import { TrackItem } from "neptune-types/tidal";
import { TrackItemCache } from "@inrixia/lib/Caches/TrackItemCache";
import { actions, intercept, store } from "@neptune";
import { debounce } from "@inrixia/lib/debounce";

import { Tracer } from "@inrixia/lib/trace";
import safeUnload from "@inrixia/lib/safeUnload";
import { interceptPromise } from "@inrixia/lib/intercept/interceptPromise";
import { MaxTrack } from "./MaxTrack";
import { ContextMenu } from "@inrixia/lib/ContextMenu";
import { AlbumCache } from "@inrixia/lib/Caches/AlbumCache";
import { settings } from "./Settings";
const trace = Tracer("[RealMAX]");

export const hasHiRes = (trackItem: TrackItem) => {
	const tags = trackItem.mediaMetadata?.tags;
	if (tags === undefined) return false;
	return tags.findIndex((tag) => tag === "HIRES_LOSSLESS") !== -1;
};

export { Settings } from "./Settings";

const unloadIntercept = intercept(
	"playbackControls/MEDIA_PRODUCT_TRANSITION",
	debounce(async () => {
		const { elements, currentIndex } = store.getState().playQueue;
		const queueId = elements[currentIndex]?.mediaItemId;
		const nextQueueId = elements[currentIndex + 1]?.mediaItemId;

		const maxItem = await MaxTrack.getMaxId(queueId);
		if (maxItem === false) return;
		if (maxItem.id !== undefined && nextQueueId !== maxItem.id) {
			await TrackItemCache.ensure(maxItem.id);
			trace.msg.log(`Found Max quality for ${maxItem.title}! Adding to queue and skipping...`);
			actions.playQueue.addNext({ mediaItemIds: [maxItem.id], context: { type: "user" } });
			actions.playQueue.moveNext();
		}
		// Preload next two
		MaxTrack.getMaxId(elements[currentIndex + 1]?.mediaItemId);
		MaxTrack.getMaxId(elements[currentIndex + 2]?.mediaItemId);
	}, 125)
);

ContextMenu.onOpen(async (contextSource, contextMenu, trackItems) => {
	document.getElementById("realMax-button")?.remove();
	if (trackItems.length === 0 || !settings.displayMaxContextButton) return;

	let sourceName = trackItems[0].title;
	if (contextSource.type === "PLAYLIST") sourceName = store.getState().content.playlists.find((playlist) => playlist.uuid === contextSource.playlistId)?.title;
	else if (contextSource.type === "ALBUM") sourceName = (await AlbumCache.get(+contextSource.albumId))?.title;
	sourceName = `${sourceName} - RealMAX`;

	const maxButton = document.createElement("button");
	maxButton.type = "button";
	maxButton.role = "menuitem";
	maxButton.textContent = `RealMAX - Process ${trackItems.length} tracks`;
	maxButton.id = "realMax-button";
	maxButton.className = "context-button"; // Set class name for styling
	contextMenu.appendChild(maxButton);
	maxButton.addEventListener("click", async () => {
		maxButton.remove();
		const maxIds: number[] = [];
		for (const index in trackItems) {
			const trackItem = trackItems[index];
			let itemId = trackItem.id!;
			const maxItem = await MaxTrack.getMaxId(trackItem.id);
			if (maxItem !== false && maxItem.id !== undefined) {
				trace.msg.log(`Found Max quality for ${maxItem.title} while processing playist ${sourceName}!`);
				trace.msg.log(`Processing tracks for RealMAX playlist ${sourceName}... ${index}/${trackItems.length - 1} done.`);
				itemId = +maxItem.id;
			}
			trace.msg.log(`Processing tracks for RealMAX playlist ${sourceName}, ${index}/${trackItems.length - 1} done. `);
			await TrackItemCache.ensure(itemId);
			maxIds.push(itemId);
		}
		const [{ playlist }] = await interceptPromise(
			() =>
				actions.folders.createPlaylist({
					description: "Automatically generated by RealMAX",
					folderId: "root",
					fromPlaylist: undefined,
					isPublic: false,
					title: sourceName,
					// @ts-expect-error This works lol
					ids: maxIds,
				}),
			["content/LOAD_PLAYLIST_SUCCESS"],
			["content/LOAD_PLAYLIST_FAIL"]
		);
		if (playlist?.uuid === undefined) {
			return trace.msg.err(`Failed to create playlist "${sourceName}"`);
		}
	});
});

export const onUnload = () => {
	unloadIntercept();
	safeUnload();
};
