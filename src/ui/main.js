import { createWallApp } from './app.js';

const root = document.querySelector('.app');
const concurrencySelect = root.querySelector('[data-role="concurrency"]');
const app = createWallApp(root, {
  getConcurrency: () => Number(concurrencySelect.value)
});

const fileInput = root.querySelector('[data-role="file-input"]');
const cancelButton = root.querySelector('[data-role="cancel"]');
const exportButton = root.querySelector('[data-role="export"]');
const manifestPreview = root.querySelector('[data-role="manifest-preview"]');

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  exportButton.disabled = true;
  cancelButton.disabled = false;
  try {
    await app.load(await file.arrayBuffer());
    exportButton.disabled = false;
  } catch {
    // status line already reports the failure
  } finally {
    cancelButton.disabled = true;
  }
});

cancelButton.addEventListener('click', () => app.cancel());

exportButton.addEventListener('click', async () => {
  const bundle = await app.exportBundle();
  manifestPreview.hidden = false;
  manifestPreview.textContent = JSON.stringify(bundle.manifest, null, 2);
  const url = URL.createObjectURL(bundle.files.find((file) => file.path === 'manifest.json').blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'manifest.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

