import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');

function loadProto(filename) {
  const packageDef = protoLoader.loadSync(resolve(PROTO_DIR, filename), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDef);
}

export function createClaudeClient(address = 'localhost:50052') {
  const proto = loadProto('claude.proto');
  return new proto.scopio.claude.ClaudeWrapper(
    address,
    grpc.credentials.createInsecure(),
  );
}

export function createBrowserClient(address = 'localhost:50053') {
  const proto = loadProto('browser.proto');
  return new proto.scopio.browser.BrowserController(
    address,
    grpc.credentials.createInsecure(),
  );
}

export function createTTSClient(address = 'localhost:50054') {
  const proto = loadProto('tts.proto');
  return new proto.scopio.tts.TTS(
    address,
    grpc.credentials.createInsecure(),
  );
}

export function createDemoBrowserClient(address = 'localhost:50057') {
  const proto = loadProto('browser.proto');
  return new proto.scopio.browser.DemoBrowser(
    address,
    grpc.credentials.createInsecure(),
    {
      // PlayAudio carries a full narration utterance of PCM (~1MB per 30s of speech)
      'grpc.max_send_message_length': 32 * 1024 * 1024,
      'grpc.max_receive_message_length': 32 * 1024 * 1024,
    },
  );
}

export function createPersistenceClient(address = 'localhost:50055') {
  const proto = loadProto('persistence.proto');
  return new proto.scopio.persistence.Persistence(
    address,
    grpc.credentials.createInsecure(),
  );
}
