import fs from 'node:fs';
import path from 'node:path';
import { createConnection, createProject, createEnvironment, createThread, insertEvents, noopNotifier, getAppSettings, setAppSettings } from '../../packages/db/src/index.ts';
import { threadScope, turnScope } from '../../packages/domain/src/index.ts';

const run = path.resolve(process.argv[2] ?? '');
if (!path.basename(run).startsWith('.perf-benchmark-')) throw Error('Expected a task-owned .perf-benchmark-* directory');
const dataDir = path.join(run, 'data');
if (fs.readFileSync(path.join(dataDir, 'verify-bb-owner'), 'utf8').trim() !== run) throw Error('Owner marker mismatch');
const manifestPath = path.join(run, 'fixture.json');
if (fs.existsSync(manifestPath)) throw Error('Fixture already exists');
const db = createConnection(path.join(dataDir, 'bb.db'));
const hostId = fs.readFileSync(path.join(dataDir, 'host-id'), 'utf8').trim();
const workspace = path.join(run, 'fixture-workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'fixture.ts'), 'export const benchmark = { name: "Synthetic E2E fixture", enabled: true };\n');
const { project } = createProject(db, noopNotifier, { name: 'Performance fixture', source: { type: 'local_path', hostId, path: workspace } });
const environment = createEnvironment(db, noopNotifier, { projectId: project.id, hostId, path: workspace, providerOwnsPath: false, status: 'ready' });
const settings = getAppSettings(db);
setAppSettings(db, { ...settings, providerCompletedTurnDisplay: { ...settings.providerCompletedTurnDisplay, codex: 'flat' } });
const fixture = { version: 1, browserName: `bb-perf-${path.basename(run)}`, fixedTime: 1789900000000, projectId: project.id, environmentId: environment.id, workspace, completedTurnDisplay: 'flat', threads: {} };
for (const [name, turns, perTurn, lastTools, lines] of [['small', 3, 2, 2, 12], ['long', 40, 12, 260, 80]]) {
  const thread = createThread(db, noopNotifier, { projectId: project.id, environmentId: environment.id, providerId: 'codex', title: `Benchmark ${name} thread`, status: 'idle' });
  const providerThreadId = `synthetic-${name}`;
  const rows = [];
  const emit = (type, data, turnId = null, itemId = null, itemKind = null) => {
    const sequence = rows.length + 1;
    rows.push({ threadId: thread.id, environmentId: environment.id, sequence, type, data: JSON.stringify(data), scope: turnId === null ? threadScope() : turnScope(turnId), itemId, itemKind, parentToolCallId: null, providerThreadId: type.startsWith('client/') ? null : providerThreadId, createdAt: fixture.fixedTime + sequence * 100 });
  };
  for (let turn = 0; turn < turns; turn++) {
    const turnId = `${name}-turn-${turn}`;
    emit('client/turn/requested', { direction: 'outbound', requestId: `creq_${String(2222222222 + turn).replace(/0/g, "a").replace(/1/g, "b")}`, source: turn ? 'tell' : 'spawn', initiator: 'user', senderThreadId: null, request: { method: 'turn/start', params: {} }, input: [{ type: 'text', text: `${name.toUpperCase()} REQUEST ${turn + 1}: Investigate retry behavior, inspect the related source files, and report the result.`, mentions: [] }], target: { kind: 'new-turn' }, execution: { model: 'gpt-5.2-codex', permissionMode: 'full', reasoningLevel: 'medium', serviceTier: 'default', source: 'client/turn/requested' } });
    emit('turn/started', { providerThreadId }, turnId);
    emit('turn/input/accepted', { providerThreadId, clientRequestId: `creq_${String(2222222222 + turn).replace(/0/g, 'a').replace(/1/g, 'b')}` }, turnId);
    const count = turn === turns - 1 ? lastTools : perTurn;
    for (let tool = 0; tool < count; tool++) {
      const itemId = `${turnId}-tool-${tool}`;
      const output = Array.from({length: lines}, (_, line) => `src/queue/worker-${tool % 12}.ts:${line + 1}: attempt=${line % 3} job=fixture-${turn}-${tool} state=${line % 4 === 0 ? 'retrying' : 'completed'} elapsed=${10 + line}ms`).join('\n');
      const item = { type: 'commandExecution', id: itemId, command: `node scripts/inspect-retries.mjs --worker=${tool % 12}`, cwd: workspace, status: 'pending', approvalStatus: null, aggregatedOutput: '' };
      emit('item/started', { providerThreadId, item }, turnId, itemId, 'commandExecution');
      emit('item/commandExecution/outputDelta', { providerThreadId, itemId, delta: output }, turnId, itemId);
      emit('item/completed', { providerThreadId, item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: output, durationMs: 70 + tool } }, turnId, itemId, 'commandExecution');
      const messageId = `${turnId}-message-${tool}`;
      emit('item/completed', { providerThreadId, item: { type: 'agentMessage', id: messageId, text: `Checked worker ${tool + 1}: retries preserve job identity and abort state. The output above contains the timing samples for this synthetic job.` } }, turnId, messageId, 'agentMessage');
    }
    const finalId = `${turnId}-final`;
    emit('item/completed', { providerThreadId, item: { type: 'agentMessage', id: finalId, text: `**${name.toUpperCase()} READY ${turn + 1}**\n\nInspected ${count} tool results. [Open fixture.ts](${path.join(workspace, 'fixture.ts')}:1).\n\n| Check | Result |\n| --- | --- |\n| Retry identity | Preserved |\n| Abort state | Preserved |` } }, turnId, finalId, 'agentMessage');
    emit('turn/completed', { providerThreadId, status: 'completed' }, turnId);
  }
  for (let i = 0; i < rows.length; i += 500) insertEvents(db, noopNotifier, rows.slice(i, i + 500));
  fixture.threads[name] = { id: thread.id, turns, eventCount: rows.length, eventJsonBytes: rows.reduce((n,r) => n + Buffer.byteLength(r.data),0), toolsPerTurn: perTurn, lastTurnTools: lastTools, outputLinesPerTool: lines };
}
fs.writeFileSync(manifestPath, JSON.stringify(fixture, null, 2));
db.$client.close();
console.log(JSON.stringify(fixture, null, 2));
