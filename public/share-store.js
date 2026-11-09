// Hands files shared from the phone's Share menu over from the service worker
// to the upload page. Used by both (self is the worker or the window).
const SHARED_DB = 'dropqr-share';

function sharedDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARED_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pending');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putSharedFiles(files) {
  const db = await sharedDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').put(files, 'files');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// Returns the shared files once and forgets them.
async function takeSharedFiles() {
  const db = await sharedDb();
  const files = await new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    const store = tx.objectStore('pending');
    const get = store.get('files');
    get.onsuccess = () => { store.delete('files'); };
    tx.oncomplete = () => resolve(get.result || []);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return files;
}
