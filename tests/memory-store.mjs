export function memoryStore() {
  const records = new Map();
  let queue = Promise.resolve();
  let operations = 0;
  const key = (kind, id) => `${kind}:${id}`;
  const api = map => ({
    async get(kind, id) { operations++; return structuredClone(map.get(key(kind, id)) || null); },
    async set(kind, id, value) { operations++; map.set(key(kind, id), structuredClone(value)); }
  });
  return {
    ...api(records),
    async orders(ids) { return ids.map(id => structuredClone(records.get(key('orders', id)))).filter(Boolean); },
    async transaction(callback) {
      let unlock;
      const prior = queue; queue = new Promise(resolve => { unlock = resolve; });
      await prior;
      const copy = structuredClone(records);
      try { const result = await callback(api(copy)); records.clear(); for (const [k, v] of copy) records.set(k, v); return result; } finally { unlock(); }
    },
    dump() { return JSON.stringify([...records]); },
    resetCount() { operations = 0; },
    count() { return operations; }
  };
}
