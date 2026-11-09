import { randomUUID } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { firebaseApp } from './firebase-admin.js';

const relationKeys = {
  wifi_sessions: { payments: ['payments', 'payment_id'], wifi_packages: ['wifi_packages', 'package_id'] },
  payments: { wifi_packages: ['wifi_packages', 'package_id'] },
  wifi_router_registry: { mikrotik_gateways: ['mikrotik_gateways', 'parent_gateway_id'] }
};
const uniqueFields = {
  wifi_packages: [['slug']], payments: [['status_token'], ['checkout_request_id'], ['mpesa_receipt_number'], ['portal_context_id'], ['mikrotik_portal_context_id']],
  wifi_sessions: [['payment_id']], opennds_portal_contexts: [['token_hash']], mikrotik_portal_contexts: [['token_hash']],
  opennds_auth_queue: [['session_id'], ['rhid']], wifi_devices: [['mac_address'], ['device_code']],
  wifi_router_registry: [['router_mac'], ['router_ip']], tyrax_router_commands: [['session_id', 'action']],
  mikrotik_router_commands: [['session_id', 'action']]
};
const now = () => new Date().toISOString();
const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

function selectRow(table, row, expression) {
  if (!row) return null;
  const fields = expression.match(/(?:^|,)\s*([\w*]+)(?=\s*(?:,|$))/g)?.map(x => x.replace(',', '').trim()).filter(Boolean) || ['*'];
  const selected = fields.includes('*') ? { ...row } : Object.fromEntries(fields.map(key => [key, row[key]]).filter(([, value]) => value !== undefined));
  const nested = [...expression.matchAll(/([\w]+)\((.*)\)/g)];
  for (const [, name, nestedFields] of nested) {
    if (relationKeys[table]?.[name]) selected[name] = row[name] ? selectRow(name, row[name], nestedFields) : null;
  }
  return selected;
}

// Relationship lookups are filled asynchronously after the base query.
function relationSpecs(table, expression) {
  return [...expression.matchAll(/([\w]+)\((.*)\)/g)].map(([, name, fields]) => ({ name, fields, relation: relationKeys[table]?.[name] })).filter(x => x.relation);
}

class Query {
  constructor(db, table) {
    this.db = db; this.table = table; this.action = 'select'; this.fields = '*'; this.filters = []; this.conditions = [];
    this.sort = []; this.max = Infinity; this.returning = false; this.head = false; this.countMode = null;
    this.one = false; this.allowNone = false; this.payload = null; this.upsertOptions = {};
  }
  select(fields = '*', options = {}) { this.fields = fields; this.returning = this.action !== 'select' || this.returning; this.head = Boolean(options.head); this.countMode = options.count || null; return this; }
  condition(field, op, value, predicate) { this.conditions.push({ field, op, value }); this.filters.push(predicate); return this; }
  eq(field, value) { return this.condition(field, '==', value, row => row[field] === value); }
  gt(field, value) { return this.condition(field, '>', value, row => row[field] != null && row[field] > value); }
  gte(field, value) { return this.condition(field, '>=', value, row => row[field] != null && row[field] >= value); }
  lt(field, value) { return this.condition(field, '<', value, row => row[field] != null && row[field] < value); }
  lte(field, value) { return this.condition(field, '<=', value, row => row[field] != null && row[field] <= value); }
  is(field, value) { return this.condition(field, '==', value, row => row[field] === value); }
  in(field, values) { return this.condition(field, 'in', values, row => values.includes(row[field])); }
  order(field, { ascending = true } = {}) { this.sort.push([field, ascending]); return this; }
  limit(value) { this.max = Math.max(0, Number(value)); return this; }
  maybeSingle() { this.one = true; this.allowNone = true; return this; }
  single() { this.one = true; return this; }
  insert(values) { this.action = 'insert'; this.payload = values; return this; }
  update(values) { this.action = 'update'; this.payload = values; return this; }
  delete() { this.action = 'delete'; return this; }
  upsert(values, options = {}) { this.action = 'upsert'; this.payload = values; this.upsertOptions = options; return this; }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
  async rows() {
    const snapshot = await this.buildQuery(this.db.collection(this.table)).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(row => this.filters.every(filter => filter(row)));
  }
  // Apply one indexed predicate in Firestore, then evaluate the remaining
  // predicates in memory. This avoids requiring a collection of composite
  // indexes for the application's small operational queues.
  buildQuery(base, conditions = this.conditions) {
    const condition = conditions[0];
    return condition ? base.where(condition.field, condition.op, condition.value) : base;
  }
  async withRelations(rows) {
    for (const spec of relationSpecs(this.table, this.fields)) {
      const [target, foreignKey] = spec.relation;
      const ids = [...new Set(rows.map(row => row[foreignKey]).filter(Boolean).map(String))];
      const found = new Map();
      for (let i = 0; i < ids.length; i += 300) {
        const refs = ids.slice(i, i + 300).map(id => this.db.collection(target).doc(id));
        if (refs.length) for (const doc of await this.db.getAll(...refs)) if (doc.exists) found.set(doc.id, { id: doc.id, ...doc.data() });
      }
      const related = [];
      for (const row of rows) {
        row[spec.name] = row[foreignKey] ? found.get(String(row[foreignKey])) || null : null;
        if (row[spec.name]) related.push(row[spec.name]);
      }
      await hydrateRelations(this.db, target, related, spec.fields);
    }
    return rows;
  }
  async project(rows) {
    await this.withRelations(rows);
    return rows.map(row => selectRow(this.table, row, this.fields));
  }
  async execute() {
    try {
      if (this.action === 'select') {
        let rows = await this.rows();
        const count = rows.length;
        for (const [field, ascending] of this.sort) rows.sort((a, b) => a[field] < b[field] ? (ascending ? -1 : 1) : a[field] > b[field] ? (ascending ? 1 : -1) : 0);
        rows = rows.slice(0, this.max);
        const data = this.head ? null : await this.project(rows);
        return this.shape(data, count);
      }
      const result = await this.mutate();
      let data = this.returning ? await this.project(result) : null;
      return this.shape(data, result.length);
    } catch (error) {
      return { data: null, error: { code: error.code || 'firestore_error', message: error.message || 'Firestore request failed' }, count: null };
    }
  }
  shape(data, count) {
    if (this.one) {
      if (!data?.length) return this.allowNone ? { data: null, error: null, count } : { data: null, error: { code: 'PGRST116', message: 'Expected one row but no rows were found' }, count };
      if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'Expected one row but multiple rows were found' }, count };
      return { data: data[0], error: null, count };
    }
    return { data, error: null, count: this.countMode ? count : null };
  }
  async mutate() {
    const values = Array.isArray(this.payload) ? this.payload : [this.payload || {}];
    const collection = this.db.collection(this.table), refs = [], deletedRows = [];
    await this.db.runTransaction(async tx => {
      refs.length = 0; deletedRows.length = 0;
      const docs = new Map();
      const addSnapshot = snapshot => { for (const doc of snapshot.docs) docs.set(doc.id, doc); };
      if (this.action === 'update' || this.action === 'delete') {
        addSnapshot(await tx.get(this.buildQuery(collection)));
      } else {
        const valuesToCheck = Array.isArray(this.payload) ? this.payload : [this.payload || {}];
        for (const value of valuesToCheck) {
          const keys = this.action === 'upsert' ? String(this.upsertOptions.onConflict || 'id').split(',').map(x => x.trim()) : ['id'];
          const conflictConditions = keys.filter(key => value[key] != null).map(key => ({ field: key, op: '==', value: value[key] }));
          if (conflictConditions.length === keys.length) addSnapshot(await tx.get(this.buildQuery(collection, conflictConditions)));
          for (const fields of uniqueFields[this.table] || []) {
            const conditions = fields.filter(key => value[key] != null).map(key => ({ field: key, op: '==', value: value[key] }));
            if (conditions.length === fields.length) addSnapshot(await tx.get(this.buildQuery(collection, conditions)));
          }
        }
      }
      const existing = [...docs.values()].map(doc => ({ ref: doc.ref, row: { id: doc.id, ...doc.data() } }));
      const writes = [];
      if (this.action === 'insert' || this.action === 'upsert') {
        for (const value of values) {
          const row = clean({ ...value, id: value.id || randomUUID(), created_at: value.created_at || now(), updated_at: value.updated_at || now() });
          const keys = this.action === 'upsert' ? String(this.upsertOptions.onConflict || 'id').split(',').map(x => x.trim()) : ['id'];
          const prior = existing.find(entry => keys.every(key => entry.row[key] === row[key]));
          if (prior && this.action === 'insert') { const error = new Error(`Duplicate ${this.table} record`); error.code = '23505'; throw error; }
          if (prior && this.upsertOptions.ignoreDuplicates) continue;
          const uniques = uniqueFields[this.table] || [];
          const duplicate = uniques.some(fields => fields.every(field => row[field] != null) && existing.some(entry => entry.ref.path !== prior?.ref.path && fields.every(field => entry.row[field] === row[field])));
          if (duplicate) { const error = new Error(`A ${this.table} record with those unique values already exists`); error.code = '23505'; throw error; }
          const ref = prior?.ref || collection.doc(String(row.id));
          const merged = prior ? { ...prior.row, ...row, id: prior.row.id } : row;
          writes.push([ref, merged]); refs.push(ref);
        }
      } else {
        const selected = existing.filter(entry => this.filters.every(filter => filter(entry.row)));
        if (this.action === 'update') {
          for (const entry of selected) {
            const next = { ...entry.row, ...this.payload };
            for (const fields of uniqueFields[this.table] || []) {
              const conditions = fields.filter(field => next[field] != null).map(field => ({ field, op: '==', value: next[field] }));
              if (conditions.length !== fields.length) continue;
              const duplicates = await tx.get(this.buildQuery(collection, conditions));
              if (duplicates.docs.some(doc => doc.id !== entry.ref.id && fields.every(field => doc.data()[field] === next[field]))) {
                const error = new Error(`A ${this.table} record with those unique values already exists`); error.code = '23505'; throw error;
              }
            }
          }
        }
        for (const entry of selected) {
          refs.push(entry.ref);
          if (this.action === 'delete') deletedRows.push(entry.row);
          if (this.action === 'update') writes.push([entry.ref, clean({ ...entry.row, ...this.payload, id: entry.row.id, updated_at: this.payload.updated_at || now() })]);
        }
      }
      for (const [ref, row] of writes) tx.set(ref, row);
      if (this.action === 'delete') for (const ref of refs) tx.delete(ref);
    });
    if (!this.returning) return [];
    if (this.action === 'delete') return this.project(deletedRows);
    const snapshots = await this.db.getAll(...refs);
    return snapshots.filter(s => s.exists).map(s => ({ id: s.id, ...s.data() }));
  }
}

async function hydrateRelations(db, table, rows, expression) {
  for (const spec of relationSpecs(table, expression)) {
    const [target, foreignKey] = spec.relation;
    const ids = [...new Set(rows.map(row => row[foreignKey]).filter(Boolean).map(String))];
    const found = new Map();
    for (let i = 0; i < ids.length; i += 300) {
      const refs = ids.slice(i, i + 300).map(id => db.collection(target).doc(id));
      if (refs.length) for (const doc of await db.getAll(...refs)) if (doc.exists) found.set(doc.id, { id: doc.id, ...doc.data() });
    }
    const related = [];
    for (const row of rows) {
      row[spec.name] = row[foreignKey] ? found.get(String(row[foreignKey])) || null : null;
      if (row[spec.name]) related.push(row[spec.name]);
    }
    await hydrateRelations(db, target, related, spec.fields);
  }
}

class FirestoreDatabase {
  constructor() { this.db = getFirestore(firebaseApp()); }
  collection(name) { return this.db.collection(name); }
  getAll(...refs) { return this.db.getAll(...refs); }
  runTransaction(fn) { return this.db.runTransaction(fn); }
  from(table) { return new Query(this.db, table); }
  async rpc(name, args = {}) {
    const queuedTable = name === 'complete_mikrotik_router_command' ? 'mikrotik_router_commands' : name === 'complete_tyrax_router_command' ? 'tyrax_router_commands' : name === 'acknowledge_opennds_auth' ? 'opennds_auth_queue' : null;
    const keyField = name === 'acknowledge_opennds_auth' ? 'rhid' : 'id';
    if (!queuedTable) return { data: null, error: { code: '42883', message: `Unknown Firebase operation: ${name}` } };
    try {
      const value = await this.db.runTransaction(async tx => {
        const queue = this.db.collection(queuedTable);
        const snapshot = name === 'acknowledge_opennds_auth'
          ? await tx.get(queue.where('rhid', '==', args.p_rhid))
          : await tx.get(queue.doc(String(args.p_command_id)));
        const queuedDoc = name === 'acknowledge_opennds_auth' ? snapshot.docs.find(doc => doc.data().gateway_hash === args.p_gateway_hash && doc.data().status === 'PENDING') : snapshot;
        if (!queuedDoc?.exists) return false;
        const command = queuedDoc.data();
        if (name !== 'acknowledge_opennds_auth' && command.status !== 'PENDING') return false;
        const sessionRef = this.db.collection('wifi_sessions').doc(String(command.session_id));
        const sessionSnap = await tx.get(sessionRef);
        if (!sessionSnap.exists) throw new Error('Associated Wi-Fi session does not exist');
        const session = sessionSnap.data(), activatedAt = now();
        const isAllow = name === 'acknowledge_opennds_auth' || command.action === 'ALLOW';
        if (isAllow) {
          if (session.session_status !== 'WAITING_GATEWAY') throw new Error('Session is not waiting for gateway authorization');
          const minutes = command.duration_minutes;
          tx.update(sessionRef, { session_status: 'ACTIVE', start_time: activatedAt, expiry_time: new Date(Date.now() + minutes * 60_000).toISOString() });
        } else if (['ACTIVE', 'WAITING_GATEWAY'].includes(session.session_status)) {
          tx.update(sessionRef, { session_status: 'EXPIRED' });
        }
        if (name === 'acknowledge_opennds_auth') tx.update(queuedDoc.ref, { status: 'AUTHENTICATED', authenticated_at: activatedAt });
        else tx.update(queuedDoc.ref, { status: 'DONE', completed_at: activatedAt, last_error: null, hotspot_password: null });
        return true;
      });
      return { data: value, error: null };
    } catch (error) { return { data: null, error: { code: error.code || 'firestore_error', message: error.message } }; }
  }
}

export const firebaseDb = () => new FirestoreDatabase();
