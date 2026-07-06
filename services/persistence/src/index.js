import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Firestore } from '@google-cloud/firestore';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const db = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
});

const CALLS_COLLECTION = 'calls';

// Transcript entries and Q&A pairs live in subcollections, not arrays on the
// call document: per-utterance arrayUnion on one doc hits Firestore's
// ~1 write/sec/doc limit during lively exchanges, silently dedupes identical
// entries, and grows toward the 1MiB doc limit on long calls.
const TRANSCRIPT_SUBCOLLECTION = 'transcript';
const QA_SUBCOLLECTION = 'qa_pairs';

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis(); // Firestore Timestamp
  if (value instanceof Date) return value.getTime();
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}

function entryTimestamp(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n) && n > 0) return n;
  logger.warn({ raw }, 'Malformed timestamp_ms on entry — substituting now()');
  return Date.now();
}

// ─── Firestore operations ───

async function saveCall(record) {
  const ref = db.collection(CALLS_COLLECTION).doc(record.call_id);
  // Only write fields the request actually carries — a metadata update must
  // never overwrite accumulated data with defaults
  const doc = {};
  if (record.zoom_meeting_id) doc.zoom_meeting_id = record.zoom_meeting_id;
  if (record.prospect_name) doc.prospect_name = record.prospect_name;
  if (record.started_at && parseInt(record.started_at, 10) > 0) {
    doc.started_at = new Date(parseInt(record.started_at, 10));
  }
  if (record.ended_at && parseInt(record.ended_at, 10) > 0) {
    doc.ended_at = new Date(parseInt(record.ended_at, 10));
  }
  if (record.steps_completed) doc.steps_completed = record.steps_completed;
  // Only write outcome when the request carries one — an outcome-less
  // metadata update must not reset a final 'completed' back to 'in_progress'
  if (record.outcome) doc.outcome = record.outcome;
  if (!doc.started_at) {
    // First write for a new call still needs a start time; merge keeps an
    // existing value if the doc already has one... but set() would overwrite,
    // so only default it when the doc doesn't exist yet
    const existing = await ref.get();
    if (!existing.exists) {
      doc.started_at = new Date();
      if (!doc.outcome) doc.outcome = 'in_progress';
    }
  }
  await ref.set(doc, { merge: true });
}

async function appendQA(callId, qa) {
  const ref = db.collection(CALLS_COLLECTION).doc(callId);
  // Empty merge-set creates the parent doc if the append raced ahead of the
  // initial SaveCall (update() would fail NOT_FOUND and lose the entry) —
  // without touching any existing fields
  await ref.set({}, { merge: true });
  await ref.collection(QA_SUBCOLLECTION).add({
    question: qa.question || '',
    answer: qa.answer || '',
    demo_step: qa.demo_step || 0,
    timestamp_ms: entryTimestamp(qa.timestamp_ms),
  });
}

async function appendTranscript(callId, entry) {
  const ref = db.collection(CALLS_COLLECTION).doc(callId);
  await ref.set({}, { merge: true });
  await ref.collection(TRANSCRIPT_SUBCOLLECTION).add({
    role: entry.role || '',
    text: (entry.text || '').slice(0, 10000),
    timestamp_ms: entryTimestamp(entry.timestamp_ms),
  });
}

async function getCall(callId) {
  const ref = db.collection(CALLS_COLLECTION).doc(callId);
  const doc = await ref.get();
  if (!doc.exists) return null;

  const data = doc.data();
  const [transcriptSnap, qaSnap] = await Promise.all([
    ref.collection(TRANSCRIPT_SUBCOLLECTION).orderBy('timestamp_ms').get(),
    ref.collection(QA_SUBCOLLECTION).orderBy('timestamp_ms').get(),
  ]);

  return {
    call_id: callId,
    zoom_meeting_id: data.zoom_meeting_id || '',
    prospect_name: data.prospect_name || '',
    // proto declares int64 — Firestore Timestamp objects serialize to garbage
    started_at: toMillis(data.started_at),
    ended_at: toMillis(data.ended_at),
    steps_completed: data.steps_completed || 0,
    outcome: data.outcome || '',
    transcript: transcriptSnap.docs.map((d) => {
      const t = d.data();
      return { call_id: callId, role: t.role, text: t.text, timestamp_ms: t.timestamp_ms };
    }),
    qa_pairs: qaSnap.docs.map((d) => {
      const q = d.data();
      return {
        call_id: callId,
        question: q.question,
        answer: q.answer,
        demo_step: q.demo_step,
        timestamp_ms: q.timestamp_ms,
      };
    }),
  };
}

async function updateOutcome(callId, outcome, stepsCompleted) {
  const ref = db.collection(CALLS_COLLECTION).doc(callId);
  // Upsert: outcome for a call whose SaveCall was lost must still be recorded
  await ref.set({
    outcome,
    steps_completed: stepsCompleted || 0,
    ended_at: new Date(),
  }, { merge: true });
}

// ─── gRPC server ───

function loadPersistenceProto() {
  const packageDef = protoLoader.loadSync(resolve(PROTO_DIR, 'persistence.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDef);
}

async function handleSaveCall(call, callback) {
  try {
    if (!call.request.call_id) {
      return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'call_id required' });
    }
    await saveCall(call.request);
    callback(null, { ok: true });
  } catch (err) {
    logger.error({ err }, 'SaveCall failed');
    callback(null, { ok: false, message: err.message });
  }
}

async function handleAppendQA(call, callback) {
  try {
    if (!call.request.call_id) {
      return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'call_id required' });
    }
    await appendQA(call.request.call_id, call.request);
    callback(null, { ok: true });
  } catch (err) {
    logger.error({ err }, 'AppendQA failed');
    callback(null, { ok: false, message: err.message });
  }
}

async function handleAppendTranscript(call, callback) {
  try {
    if (!call.request.call_id) {
      return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'call_id required' });
    }
    await appendTranscript(call.request.call_id, call.request);
    callback(null, { ok: true });
  } catch (err) {
    logger.error({ err }, 'AppendTranscript failed');
    callback(null, { ok: false, message: err.message });
  }
}

async function handleGetCall(call, callback) {
  try {
    const record = await getCall(call.request.call_id);
    if (!record) {
      callback(null, { call_id: call.request.call_id });
      return;
    }
    callback(null, record);
  } catch (err) {
    logger.error({ err }, 'GetCall failed');
    callback(null, { call_id: call.request.call_id });
  }
}

async function handleUpdateOutcome(call, callback) {
  try {
    if (!call.request.call_id) {
      return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'call_id required' });
    }
    await updateOutcome(
      call.request.call_id,
      call.request.outcome,
      call.request.steps_completed,
    );
    callback(null, { ok: true });
  } catch (err) {
    logger.error({ err }, 'UpdateOutcome failed');
    callback(null, { ok: false, message: err.message });
  }
}

// ─── Main ───

async function main() {
  const proto = loadPersistenceProto();
  const server = new grpc.Server();

  server.addService(proto.scopio.persistence.Persistence.service, {
    saveCall: handleSaveCall,
    appendQA: handleAppendQA,
    appendTranscript: handleAppendTranscript,
    getCall: handleGetCall,
    updateOutcome: handleUpdateOutcome,
  });

  const port = process.env.GRPC_PORT || '50055';
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) {
      logger.error({ err }, `Failed to bind persistence gRPC on :${port}`);
      process.exit(1);
    }
    logger.info(`Persistence service gRPC listening on :${port}`);
    logger.info(`Firestore project: ${process.env.GOOGLE_CLOUD_PROJECT || '(not set)'}`);
  });
}

main().catch((err) => {
  logger.error(err, 'Failed to start persistence service');
  process.exit(1);
});
