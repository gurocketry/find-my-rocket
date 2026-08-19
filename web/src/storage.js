const DB_NAME = "gur-rocket-tracker";
const STORE_NAME = "records";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      store.createIndex("loggedAt", "loggedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function storeRecord(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).add({ loggedAt: new Date().toISOString(), ...record });
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

export async function loadRecords() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
    request.onsuccess = () => { db.close(); resolve(request.result); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function exportRecords() {
  const records = await loadRecords();
  const text = records.map(({ id: _id, ...record }) => JSON.stringify(record)).join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `astra-telemetry-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  link.click();
  URL.revokeObjectURL(url);
}
