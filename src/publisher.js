const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { AppError } = require('./catalog');

const defaultLimits = { uploadBytes: 100 * 1024 * 1024, expandedBytes: 256 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, entries: 5000, timeoutMs: 30000 };

function extract(archive, destination, limits) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'extract-worker.js'), {
      workerData: { archive, destination, limits }, resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = async ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (ok) resolve(); else reject(new AppError(400, 'Use a valid ZIP with index.html at its root, safe file paths, and files within the upload limits.'));
    };
    const timer = setTimeout(() => void finish(false), limits.timeoutMs);
    worker.once('message', value => void finish(value.ok === true));
    worker.once('error', () => void finish(false));
    worker.once('exit', () => void finish(false));
  });
}

async function publish(catalog, slug, archive, limits = defaultLimits) {
  catalog.assertPublishable(slug);
  const release = randomUUID();
  const directory = path.join(catalog.config.dataDirectory, 'releases', slug, release);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    await extract(archive, directory, limits);
    catalog.assertPublishable(slug);
    catalog.activate(slug, release);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { success: true, project: slug, message: `Successfully published to /${slug}`, url: new URL(`${slug}/`, catalog.config.baseUrl).href };
}

module.exports = { publish, defaultLimits };
