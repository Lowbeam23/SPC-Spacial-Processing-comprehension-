/**
 * Persistent Storage Helper for Authentic PS1 512KB System BIOS ROMs
 * Uses IndexedDB with localStorage fallback to retain the dumped BIOS across page refreshes.
 */

const DB_NAME = 'ps1_emulator_db';
const DB_VERSION = 1;
const STORE_NAME = 'bios_store';
const KEY_NAME = 'current_scph_bios';

interface StoredBiosRecord {
  key: string;
  name: string;
  data: Uint8Array;
  size: number;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Saves a 512 KB BIOS ROM dump to persistent storage
 */
export async function saveBiosToStorage(data: Uint8Array, fileName: string): Promise<void> {
  // Validate exact 512 KB (524,288 bytes)
  if (data.length !== 524288) {
    throw new Error(`Invalid PS1 BIOS size: ${data.length.toLocaleString()} bytes. Authentic PS1 BIOS dumps must be exactly 524,288 bytes (512 KB).`);
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: StoredBiosRecord = {
        key: KEY_NAME,
        name: fileName,
        data,
        size: data.length,
        updatedAt: Date.now(),
      };
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch (idbErr) {
    console.warn('IndexedDB save failed, attempting localStorage fallback:', idbErr);
    try {
      // Base64 encode for localStorage (512KB -> ~680KB base64 string)
      let binary = '';
      const len = data.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(data[i]);
      }
      const b64 = btoa(binary);
      localStorage.setItem('ps1_scph_bios_b64', b64);
      localStorage.setItem('ps1_scph_bios_name', fileName);
    } catch (lsErr) {
      console.error('LocalStorage fallback also failed:', lsErr);
    }
  }
}

/**
 * Loads the saved 512 KB BIOS ROM from persistent storage
 */
export async function loadBiosFromStorage(): Promise<{ data: Uint8Array; fileName: string } | null> {
  try {
    const db = await openDb();
    const result = await new Promise<StoredBiosRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(KEY_NAME);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });

    if (result && result.data && result.data.length === 524288) {
      return { data: result.data, fileName: result.name };
    }
  } catch (idbErr) {
    console.warn('IndexedDB load failed, attempting localStorage fallback:', idbErr);
  }

  // Fallback to localStorage
  try {
    const b64 = localStorage.getItem('ps1_scph_bios_b64');
    const name = localStorage.getItem('ps1_scph_bios_name') || 'SCPH-1001.bin';
    if (b64) {
      const binary = atob(b64);
      if (binary.length === 524288) {
        const bytes = new Uint8Array(524288);
        for (let i = 0; i < 524288; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return { data: bytes, fileName: name };
      }
    }
  } catch (lsErr) {
    console.warn('LocalStorage load failed:', lsErr);
  }

  return null;
}

/**
 * Removes the saved BIOS from persistent storage
 */
export async function deleteBiosFromStorage(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(KEY_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch (idbErr) {
    console.warn('IndexedDB delete failed:', idbErr);
  }

  try {
    localStorage.removeItem('ps1_scph_bios_b64');
    localStorage.removeItem('ps1_scph_bios_name');
  } catch (lsErr) {
    console.warn('LocalStorage delete failed:', lsErr);
  }
}
