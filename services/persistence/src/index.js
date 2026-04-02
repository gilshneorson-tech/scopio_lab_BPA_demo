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

// ─── Firestore operations ───

async function saveCall(record) {
  const ref = db.collection(CALLS_COLLECTION).doc(record.call_id);
  await ref.set({
    zoom_meeting_id: record.zoom_meeting_id || '',
    prospect_name: record.prospect_name || '',
    started_at: record.started_at ? new Date(parseInt(record.started_at)) : new Date(),
    ended_at: record.ended_at ? new Date(parseInt(record.ended_at)) : null,
    steps_completed: record.steps_completed || 0,
    outcome: record.outcome || 'in_progress',
    transcript: record.transcript || [],
    qa_pairs: record.qa_pairs || [],
  }, { merge: true });
}

async function appendQA(callId, qa) {
  const ref = db.collection(CALLS_COLLECTION).doc(callId);
  await ref.update({
    qa_pairs: Firestore.FieldValue.arrayUnion({
      question: qa.question,
      answer: qa.answer,
      demo_step: qa.demo_step,
      timestamp_ms: parseInt(qa.timestamp_ms) || Date.now(),
    }),
  });
}

async function appendTranscript(callId, entry) {
  const ref = db.collection(CALLS_COLLECTION).doc(callId);
  await ref.update({
    transcript: Firestore.FieldValue.arrayUnion({
      role: entry.role,
      text: entry.text,
      timestamp_ms: parseInt(entry.timestamp_ms) || Date.now(),
    }),
  });
}

async function getCall(callId) {
  const doc = await db.collection(CALLS_COLLECTION).doc(callId).get();
  if (!doc.exists) return null;
  return { call_id: callId, ...doc.data() };
}

async function updateOutcome(callId, outcome, stepsCompleted) {
  const ref = db.collection(CALLS_COLLECTION).doc(callId);
  await ref.update({
    outcome,
    steps_completed: stepsCompleted,
    ended_at: new Date(),
  });
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
    await saveCall(call.request);
    callback(null, { ok: true });
  } catch (err) {
    logger.error({ err }, 'SaveCall failed');
    callback(null, { ok: false, message: err.message });
  }
}

async function handleAppendQA(call, callback) {
  try {
    await appendQA(call.request.call_id, call.request);
    callback(null, { ok: true });
  } catch (err) {
    logger.error({ err }, 'AppendQA failed');
    callback(null, { ok: false, message: err.message });
  }
}

async function handleAppendTranscript(call, callback) {
  try {
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
    if (err) throw err;
    logger.info(`Persistence service gRPC listening on :${port}`);
    logger.info(`Firestore project: ${process.env.GOOGLE_CLOUD_PROJECT || '(not set)'}`);
  });
}

main().catch((err) => {
  logger.error(err, 'Failed to start persistence service');
  process.exit(1);
});
