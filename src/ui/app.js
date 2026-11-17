// Thumbnail wall UI: one row per chapter, three candidate frames per row,
// click-to-select representative frame, and manifest/PNG export.
import { generateThumbnailWall } from '../thumbnail-generator.js';
import { buildExportBundle } from '../manifest.js';
import { FrameRegistry } from '../frame-registry.js';

function formatPts(ptsMs) {
  const totalSeconds = ptsMs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, '0');
  return `${String(minutes).padStart(2, '0')}:${seconds}`;
}

export function createWallApp(
  rootElement,
  { concurrency = 2, thumbnailWidth = 160, getConcurrency } = {}
) {
  const state = {
    wall: null,
    selections: new Map(),
    registry: null,
    abortController: null,
    running: false
  };

  const listeners = new Set();
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const onChange = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  function renderStatus(text, isError = false) {
    rootElement.querySelector('[data-role="status"]').textContent = text;
    rootElement.querySelector('[data-role="status"]').classList.toggle('error', isError);
  }

  function renderWall() {
    const grid = rootElement.querySelector('[data-role="grid"]');
    grid.innerHTML = '';
    for (const chapter of state.wall.chapters) {
      const row = document.createElement('section');
      row.className = 'chapter-row';
      const header = document.createElement('header');
      header.innerHTML =
        `<strong>${chapter.title}</strong>` +
        `<span>${formatPts(chapter.startMs)} – ${formatPts(chapter.endMs)}</span>`;
      row.appendChild(header);

      const strip = document.createElement('div');
      strip.className = 'thumbnail-strip';
      chapter.thumbnails.forEach((thumbnail, slotIndex) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'thumbnail-card';
        card.dataset.chapterIndex = String(chapter.chapterIndex);
        card.dataset.slot = thumbnail.slot;
        card.dataset.ptsMs = String(thumbnail.ptsMs);
        const selectedSlot =
          state.selections.get(chapter.chapterIndex)?.slot ?? 'middle';
        card.classList.toggle('selected', thumbnail.slot === selectedSlot);
        const image = document.createElement('img');
        image.src = URL.createObjectURL(thumbnail.blob);
        image.alt = `${chapter.title} ${thumbnail.slot} at ${thumbnail.ptsMs} ms`;
        image.width = thumbnail.width;
        image.height = thumbnail.height;
        card.appendChild(image);
        const caption = document.createElement('span');
        caption.className = 'caption';
        caption.textContent = `${thumbnail.slot} · PTS ${thumbnail.ptsMs} ms`;
        card.appendChild(caption);
        card.addEventListener('click', () => {
          state.selections.set(chapter.chapterIndex, {
            slot: thumbnail.slot,
            ptsMs: thumbnail.ptsMs
          });
          strip.querySelectorAll('.thumbnail-card').forEach((element) => {
            element.classList.toggle('selected', element === card);
          });
          emit({ type: 'select', chapterIndex: chapter.chapterIndex, thumbnail });
        });
        strip.appendChild(card);
      });
      row.appendChild(strip);
      grid.appendChild(row);
    }
  }

  async function load(arrayBuffer) {
    if (state.running) throw new Error('a generation run is already active');
    state.running = true;
    state.abortController = new AbortController();
    state.registry = new FrameRegistry();
    renderStatus('Decoding chapter thumbnails…');
    const effectiveConcurrency = getConcurrency ? getConcurrency() : concurrency;
    try {
      const wall = await generateThumbnailWall(arrayBuffer, {
        concurrency: effectiveConcurrency,
        thumbnailWidth,
        signal: state.abortController.signal,
        frameRegistry: state.registry
      });
      state.wall = wall;
      state.selections = new Map();
      renderStatus(
        `Ready: ${wall.chapters.length} chapters, ` +
          `${wall.chapters.length * 3} thumbnails, concurrency ${wall.stats.concurrency}`
      );
      renderWall();
      emit({ type: 'loaded', wall });
      return wall;
    } catch (error) {
      renderStatus(error.name === 'AbortError' ? 'Generation cancelled.' : error.message, error.name !== 'AbortError');
      emit({ type: 'error', error });
      throw error;
    } finally {
      state.running = false;
      state.abortController = null;
    }
  }

  function cancel() {
    state.abortController?.abort();
  }

  async function exportBundle() {
    if (!state.wall) throw new Error('load a video before exporting');
    const bundle = await buildExportBundle(state.wall, state.selections);
    emit({ type: 'export', manifest: bundle.manifest, fileCount: bundle.files.length });
    return bundle;
  }

  return { load, cancel, exportBundle, onChange, getState: () => state };
}
