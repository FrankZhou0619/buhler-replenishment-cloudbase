const collections = { state: 'replenishment_state', orders: 'replenishment_orders', ops: 'replenishment_ops' };
function clean(data) {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value) return null;
  const { _id, ...record } = value;
  return record;
}
function checked(result) {
  if (result?.code) throw result;
  return result;
}
export function cloudStore(db) {
  const ref = (kind, id) => db.collection(collections[kind]).doc(id);
  const transactionRef = (transaction, kind, id) => transaction.collection(collections[kind]).doc(id);
  const store = {
    async get(kind, id) { return clean(checked(await ref(kind, id).get()).data); },
    async set(kind, id, value) { checked(await ref(kind, id).set(clean(value))); },
    async orders(ids) {
      if (!ids.length) return [];
      const rows = checked(await db.collection(collections.orders).where({ _id: db.command.in(ids) }).limit(100).get()).data;
      const map = new Map(rows.map(row => [row._id, clean(row)]));
      return ids.map(id => map.get(id)).filter(Boolean);
    },
    async transaction(callback) {
      // The installed Node SDK runTransaction discards callback return values.
      // Explicit commit also avoids retrying application validation failures.
      for (let attempt = 0; attempt < 3; attempt++) {
        const transaction = await db.startTransaction();
        try {
          const tx = {
            async get(kind, id) { return clean(checked(await transactionRef(transaction, kind, id).get()).data); },
            async set(kind, id, value) { checked(await transactionRef(transaction, kind, id).set(clean(value))); }
          };
          const result = await callback(tx);
          checked(await transaction.commit());
          return result;
        } catch (error) {
          await transaction.rollback().catch(() => {});
          const conflict = /TRANSACTION.*CONFLICT|WRITE.*CONFLICT|TransactionConflict/i.test(String(error?.code || ''));
          if (!conflict || attempt === 2) throw error;
        }
      }
    }
  };
  return store;
}
